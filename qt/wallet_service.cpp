#include "wallet_service.h"
#include "noticoin_network.h"
#include "wallet_ui.h"
#include <QAuthenticator>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkProxy>
#include <QNetworkReply>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSet>
#include <QTcpServer>
#include <QTemporaryFile>
#include <QThread>
#include <QUuid>
#include <algorithm>
#include <limits>
#include <optional>
#include <openssl/evp.h>
#ifdef Q_OS_WIN
#include <windows.h>
#endif

namespace noticoin {
namespace {
constexpr quint64 units = noticoin::network::atomicUnits;
constexpr auto mapPurchaseNote = "noti:map-note-purchase:v1";
class RpcRejected : public Error {
public:
    RpcRejected(const QString &message, int code) : Error(message), code(code) {}
    const int code;
};

QByteArray literal(const QString &value)
{
    auto array = QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
    return array.mid(1, array.size() - 2);
}

quint64 number(const rapidjson::Value &value, const char *key)
{
    const auto member = value.FindMember(key);
    return member != value.MemberEnd() && member->value.IsUint64() ? member->value.GetUint64() : 0;
}

QString string(const rapidjson::Value &value, const char *key)
{
    const auto member = value.FindMember(key);
    return member != value.MemberEnd() && member->value.IsString()
        ? QString::fromUtf8(member->value.GetString(), member->value.GetStringLength()) : QString();
}

bool flag(const rapidjson::Value &value, const char *key)
{
    const auto member = value.FindMember(key);
    return member != value.MemberEnd() && member->value.IsBool() && member->value.GetBool();
}

bool signedMapRecord(QByteArrayView data)
{
    if (data.size() != 118 || data.first(4) != "NTMP" || data[4] != 1 || (data[5] != 1 && data[5] != 2)) return false;
    const auto *bytes = reinterpret_cast<const unsigned char *>(data.data());
    std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
        EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, bytes + 22, 32), EVP_PKEY_free);
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    return key && context && EVP_DigestVerifyInit(context.get(), nullptr, nullptr, nullptr, key.get()) == 1
        && EVP_DigestVerify(context.get(), bytes + 54, 64, bytes, 54) == 1;
}

QJsonObject mapPurpose(const rapidjson::Value &extra)
{
    if (!extra.IsArray()) return {};
    QByteArray bytes;
    for (const auto &value : extra.GetArray()) {
        if (!value.IsUint() || value.GetUint() > 255) return {};
        bytes.append(char(value.GetUint()));
    }
    for (qsizetype offset = 0; offset < bytes.size();) {
        const auto tag = quint8(bytes.at(offset++));
        if (tag == 0) continue;
        if (tag == 1) { offset += 32; continue; }
        if (tag != 2 && tag != 3 && tag != 4 && tag != 0xde) return {};
        quint64 length = 0;
        for (int shift = 0;; shift += 7) {
            if (offset >= bytes.size() || shift > 56) return {};
            const auto next = quint8(bytes.at(offset++));
            length |= quint64(next & 0x7f) << shift;
            if (!(next & 0x80)) break;
        }
        const auto stride = tag == 4 ? 32u : 1u;
        if (length > quint64(bytes.size() - offset) / stride) return {};
        const auto field = QByteArrayView(bytes).sliced(offset, qsizetype(length * stride));
        offset += field.size();
        if (tag != 2 || !signedMapRecord(field)) continue;
        return {{"mapOperation", field[5] == 1 ? "publish" : "withdraw"},
                {"mapPoint", QUuid::fromRfc4122(field.sliced(6, 16).toByteArray()).toString(QUuid::WithoutBraces)}};
    }
    return {};
}

QString secret()
{
    QByteArray bytes(32, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i) bytes[i] = char(QRandomGenerator::system()->generate() & 255);
    return QString::fromLatin1(bytes.toHex());
}

quint16 localPort()
{
    QTcpServer listener;
    if (!listener.listen(QHostAddress::LocalHost)) throw Error(listener.errorString());
    return listener.serverPort();
}

void launch(QProcess &process, const QString &path, const QStringList &arguments, const QString &log)
{
    process.setStandardOutputFile(log, QIODevice::Append);
    process.setStandardErrorFile(log, QIODevice::Append);
#ifdef Q_OS_WIN
    process.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *a) { a->flags |= CREATE_NO_WINDOW; });
#endif
    process.start(path, arguments, QIODevice::ReadOnly);
    if (!process.waitForStarted(6000)) throw Error(process.errorString());
}

void waitForRpc(Rpc &rpc, QProcess &process)
{
    QElapsedTimer deadline;
    deadline.start();
    QString error;
    while (deadline.elapsed() < 18000 && process.state() != QProcess::NotRunning) {
        try {
            rpc.call("get_version");
            return;
        } catch (const std::exception &e) {
            error = QString::fromUtf8(e.what());
            QThread::msleep(200);
        }
    }
    throw Error(ui("The Noticoin service did not start. ") + error);
}

void stopProcess(QProcess &process)
{
    if (process.state() == QProcess::NotRunning || process.waitForFinished(2500)) return;
    process.kill();
    process.waitForFinished(2500);
}

void configure(QTemporaryFile &file, const QString &content)
{
    const auto bytes = content.toUtf8();
    if (!file.open() || file.write(bytes) != bytes.size() || !file.flush())
        throw Error(ui("Could not create the wallet's temporary access file."));
    file.close();
}
}

QString money(quint64 amount)
{
    QString fraction = QString::number(amount % units).rightJustified(noticoin::network::decimals, '0');
    while (fraction.endsWith('0')) fraction.chop(1);
    return QString::number(amount / units) + (fraction.isEmpty() ? QString() : "." + fraction);
}

quint64 parseMoney(QString input)
{
    input = input.trimmed().replace(',', '.');
    static const QRegularExpression amount(R"(^[0-9]+(?:\.[0-9]{1,9})?$)");
    if (!amount.match(input).hasMatch()) throw Error(ui("Enter an amount with up to 9 decimal places."));
    const auto parts = input.split('.');
    bool ok = false;
    const auto whole = parts[0].toULongLong(&ok);
    const auto fraction = parts.size() == 2 ? parts[1].leftJustified(noticoin::network::decimals, '0').toULongLong() : 0;
    if (!ok || whole > (std::numeric_limits<quint64>::max() - fraction) / units)
        throw Error(ui("The amount exceeds the supported limit."));
    const auto result = whole * units + fraction;
    if (result == 0) throw Error(ui("The amount must be greater than zero."));
    return result;
}

Rpc::Rpc(quint16 port, QString password) : port(port), password(std::move(password))
{
    network.setProxy(QNetworkProxy::NoProxy);
    QObject::connect(&network, &QNetworkAccessManager::authenticationRequired, &network,
                     [this](QNetworkReply *, QAuthenticator *auth) {
        auth->setUser("noticoin");
        auth->setPassword(this->password);
    });
}

Document Rpc::call(const QString &method, const QJsonObject &parameters, bool jsonRpc)
{
    return request(method, QJsonDocument(parameters).toJson(QJsonDocument::Compact), jsonRpc);
}

Document Rpc::request(const QString &method, const QByteArray &parameters, bool jsonRpc)
{
    const auto path = jsonRpc ? QString("/json_rpc") : "/" + method;
    QNetworkRequest request(QUrl(QString("http://127.0.0.1:%1%2").arg(port).arg(path)));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    request.setAttribute(QNetworkRequest::Http2AllowedAttribute, false);
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setTransferTimeout(method == "generateblocks" || method == "sweep_all" ? 180000 : 65000);
    const auto body = jsonRpc ? "{\"jsonrpc\":\"2.0\",\"id\":\"noticoin-qt\",\"method\":" + literal(method)
        + ",\"params\":" + parameters + "}" : parameters;
    auto *reply = network.post(request, body);
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    if (!reply->isFinished()) loop.exec();
    const QByteArray raw = reply->readAll();
    const auto transportError = reply->error();
    const auto transportMessage = reply->errorString();
    reply->deleteLater();
    if (transportError != QNetworkReply::NoError) throw Error(transportMessage);
    Document response;
    if (raw.size() > 16000000 || response.Parse(raw.constData(), raw.size()).HasParseError() || !response.IsObject())
        throw Error(ui("The Noticoin service returned an invalid response."));
    if (response.HasMember("error") && response["error"].IsObject()) {
        const auto &error = response["error"];
        const auto code = error.FindMember("code");
        throw RpcRejected(string(error, "message"), code != error.MemberEnd() && code->value.IsInt() ? code->value.GetInt() : 0);
    }
    if (!jsonRpc) {
        const auto status = string(response, "status");
        if (!status.isEmpty() && status != "OK") throw Error(status);
        return response;
    }
    if (!response.HasMember("result") || !response["result"].IsObject()) throw Error(ui("The Noticoin service returned an empty response."));
    Document result;
    result.CopyFrom(response["result"], result.GetAllocator());
    const auto status = string(result, "status");
    if (!status.isEmpty() && status != "OK") throw Error(status);
    return result;
}

WalletService::WalletService(QString root, QString data, bool regtest, quint16 regtestPort)
    : root(std::move(root)), data(std::move(data)), walletDir(this->data + walletDirectory), regtest(regtest), regtestPort(regtestPort)
{
    if (!QDir().mkpath(walletDir)) throw Error(ui("Could not open the wallet folder."));
}
WalletService::~WalletService()
{
    stopProcess(walletProcess);
    stopProcess(daemonProcess);
}

void WalletService::start()
{
    if (wallet) return;
#ifdef Q_OS_WIN
    const QString suffix = ".exe";
#else
    const QString suffix;
#endif
    const auto daemonPassword = secret(), walletPassword = secret();
    const auto daemonPort = regtestPort ? regtestPort : localPort();
    const auto walletPort = localPort(), p2pPort = localPort();
    QTemporaryFile daemonConfig(data + "/daemon-XXXXXX.conf"), walletConfig(data + "/wallet-XXXXXX.conf");
    try {
        auto walletConfigText = "rpc-login=noticoin:" + walletPassword + "\n";
        if (!regtestPort) walletConfigText += "daemon-login=noticoin:" + daemonPassword + "\n";
        configure(walletConfig, walletConfigText);
        auto candidate = std::make_unique<Rpc>(daemonPort, regtestPort ? QString() : daemonPassword);
        if (regtestPort) {
            const auto info = candidate->call("get_info");
            if (string(info, "nettype") != "fakechain" || !flag(info, "offline"))
                throw Error(ui("The selected node must be an offline regtest daemon."));
        } else {
            configure(daemonConfig, "rpc-login=noticoin:" + daemonPassword + "\n");
            QStringList daemonArgs{"--config-file", daemonConfig.fileName(), "--data-dir", data + "/chain-v3",
                "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", QString::number(daemonPort), "--p2p-bind-ip", "127.0.0.1",
                "--p2p-bind-port", QString::number(p2pPort), "--no-zmq", "--non-interactive", "--log-level", "0",
                "--max-log-file-size", "1048576", "--max-log-files", "2", "--log-file", data + "/node.log"};
            if (regtest) daemonArgs << "--regtest" << "--fixed-difficulty" << "1" << "--offline";
            launch(daemonProcess, root + "/bin/noticoind" + suffix, daemonArgs, data + "/daemon-console.log");
            waitForRpc(*candidate, daemonProcess);
        }
        auto first = candidate->call("get_block_header_by_height", {{"height", 0}});
        const auto genesis = noticoin::network::mainnet;
        if (!first.HasMember("block_header") || !first["block_header"].IsObject()
            || string(first["block_header"], "hash") != QString::fromLatin1(genesis.data(), genesis.size()))
            throw Error(ui("The node is outside the Noticoin network."));
        launch(walletProcess, root + "/bin/noticoin-wallet-rpc" + suffix,
            {"--config-file", walletConfig.fileName(), "--wallet-dir", walletDir,
             "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", QString::number(walletPort),
             "--daemon-address", QString("http://127.0.0.1:%1").arg(daemonPort), "--trusted-daemon",
             "--non-interactive", "--log-level", "0", "--max-log-file-size", "1048576",
             "--max-log-files", "2", "--log-file", data + "/wallet-rpc.log"}, data + "/wallet-console.log");
        auto service = std::make_unique<Rpc>(walletPort, walletPassword);
        waitForRpc(*service, walletProcess);
        service->call("auto_refresh", {{"enable", true}, {"period", 5}});
        daemon = std::move(candidate);
        wallet = std::move(service);
    } catch (...) {
        stopProcess(walletProcess);
        stopProcess(daemonProcess);
        throw;
    }
}

void WalletService::requireWallet() const
{
    if (active.isEmpty()) throw Error(ui("Open a wallet first."));
}

void WalletService::lockAfterFailedOpen()
{
    try { close(); }
    catch (...) {
        stopProcess(walletProcess);
        stopProcess(daemonProcess);
        wallet.reset();
        daemon.reset();
        active.clear();
        address.clear();
        mapHistory.clear();
        discard();
    }
}

QJsonObject WalletService::open(const QString &name, const QString &password, const QString &mode,
                                const QString &seed, qint64 restoreHeight, const QString &seedLanguage)
{
    static const QRegularExpression names(R"(^[\p{L}\p{N}_-]{1,48}$)");
    if (!names.match(name).hasMatch()) throw Error(ui("Use up to 48 letters, digits, hyphens or underscores."));
    const bool replacing = isOpen();
    if (replacing && (mode != "open" || name == active)) throw Error(ui("Close the current wallet first."));
    if (mode != "open" && (QFile::exists(walletDir + "/" + name) || QFile::exists(walletDir + "/" + name + ".keys")))
        throw Error(ui("A wallet with that name already exists."));
    start();
    QJsonObject args{{"filename", name}, {"password", password}};
    if (mode == "open") {
        args.insert("autosave_current", true);
        try { wallet->call("open_wallet", args); }
        catch (const RpcRejected &) { throw; } // The RPC replaces the current wallet only after validating the new one.
        catch (...) {
            if (replacing) lockAfterFailedOpen();
            throw;
        }
    } else if (mode == "restore") {
        args.insert("seed", seed.simplified());
        if (restoreHeight < 0) throw Error(ui("Restore height must be a whole number of 0 or greater."));
        args.insert("restore_height", restoreHeight);
        args.insert("language", seedLanguage);
        wallet->call("restore_deterministic_wallet", args);
    } else {
        args.insert("language", seedLanguage);
        wallet->call("create_wallet", args);
    }
    active = name;
    address.clear();
    mapHistory.clear();
    discard();
    try {
        address = string(wallet->call("get_address", {{"account_index", 0}}), "address");
        return snapshot(false, true, true);
    }
    catch (...) { lockAfterFailedOpen(); throw; }
}

QJsonObject WalletService::snapshot(bool history, bool addresses, bool watchIncoming)
{
    QJsonObject state{{"wallet", active}, {"address", address}};
    if (!daemon) return state;
    const auto info = daemon->call("get_info");
    state.insert("height", QString::number(number(info, "height")));
    state.insert("peers", int(number(info, "incoming_connections_count") + number(info, "outgoing_connections_count")));
    if (active.isEmpty()) return state;
    const auto balance = wallet->call("get_balance", {{"account_index", 0}});
    const auto total = number(balance, "balance");
    const auto unlocked = number(balance, "unlocked_balance");
    state.insert("balance", money(total));
    state.insert("available", money(unlocked));
    state.insert("locked", money(total > unlocked ? total - unlocked : 0));
    if (addresses) state.insert("subaddresses", subaddresses());
    if (!history && !watchIncoming) return state;
    const auto height = number(wallet->call("get_height"), "height");
    const quint64 lookback = history ? 10000 : 100;
    const auto transfers = wallet->call("get_transfers", {{"in", true}, {"out", history}, {"pending", history},
        {"pool", true}, {"account_index", 0}, {"filter_by_height", true}, {"min_height", qint64(height > lookback ? height - lookback : 0)}});
    QList<QJsonObject> rows;
    QJsonArray incoming;
    std::optional<QSet<QString>> ownAddresses;
    for (const auto *group : {"in", "out", "pending", "pool"}) {
        if (!transfers.HasMember(group) || !transfers[group].IsArray()) continue;
        const auto kind = QString::fromLatin1(group);
        for (const auto &tx : transfers[group].GetArray()) {
            if (!tx.IsObject()) continue;
            if (watchIncoming && (kind == "in" || kind == "pool") && string(tx, "type") != "block") {
                incoming.append(QJsonObject{{"id", string(tx, "txid")}, {"amount", money(number(tx, "amount"))},
                    {"height", qint64(number(tx, "height"))}, {"pooled", kind == "pool"}});
            }
            if (!history) continue;
            QJsonArray addresses;
            auto amount = number(tx, "amount");
            bool selfTransfer = false;
            if (kind == "in" || kind == "pool") {
                const auto recipient = string(tx, "address");
                if (!recipient.isEmpty()) addresses.append(recipient);
            } else if (tx.HasMember("destinations") && tx["destinations"].IsArray()) {
                quint64 destinationAmount = 0;
                for (const auto &destination : tx["destinations"].GetArray()) {
                    if (!destination.IsObject()) continue;
                    const auto recipient = string(destination, "address");
                    if (!recipient.isEmpty()) addresses.append(recipient);
                    destinationAmount += number(destination, "amount");
                }
                // For a confirmed transfer within the account, RPC reports zero external
                // amount but preserves the amount originally sent in the destinations.
                selfTransfer = kind == "out" && amount == 0 && destinationAmount > 0;
                if (kind == "pending" && !addresses.isEmpty()) {
                    if (!ownAddresses) {
                        ownAddresses.emplace(QSet<QString>{address});
                        const auto local = state.contains("subaddresses") ? state["subaddresses"].toArray() : subaddresses();
                        for (const auto &row : local) ownAddresses->insert(row.toObject()["address"].toString());
                    }
                    selfTransfer = std::all_of(addresses.begin(), addresses.end(), [&ownAddresses](const auto &recipient) {
                        return ownAddresses->contains(recipient.toString());
                    });
                }
                if (selfTransfer) amount = destinationAmount;
            }
            rows << QJsonObject{
                {"id", string(tx, "txid")}, {"kind", kind}, {"amount", money(amount)}, {"selfTransfer", selfTransfer},
                {"time", qint64(number(tx, "timestamp"))}, {"confirmations", qint64(number(tx, "confirmations"))},
                {"height", qint64(number(tx, "height"))}, {"fee", money(number(tx, "fee"))}, {"addresses", addresses},
                {"mapPurchase", (kind == "out" || kind == "pending") && string(tx, "note") == mapPurchaseNote}
            };
        }
    }
    if (watchIncoming) state.insert("incoming", incoming);
    if (!history) return state;
    std::sort(rows.begin(), rows.end(), [](const auto &a, const auto &b) { return a["time"].toInteger() > b["time"].toInteger(); });
    const auto count = qMin<qsizetype>(rows.size(), 100);
    if (mapHistory.size() > 400) mapHistory.clear();
    QJsonArray unknown;
    for (qsizetype i = 0; i < count; ++i) {
        const auto id = rows[i]["id"].toString();
        if (!id.isEmpty() && !mapHistory.contains(id)) unknown.append(id);
    }
    if (!unknown.isEmpty()) {
        try {
            const auto response = daemon->call("get_transactions", {{"txs_hashes", unknown}, {"decode_as_json", true}, {"prune", true}}, false);
            if (response.HasMember("txs") && response["txs"].IsArray()) {
                for (const auto &tx : response["txs"].GetArray()) {
                    if (!tx.IsObject()) continue;
                    const auto encoded = string(tx, "as_json").toUtf8();
                    Document transaction;
                    if (transaction.Parse(encoded.constData(), encoded.size()).HasParseError() || !transaction.IsObject() || !transaction.HasMember("extra")) continue;
                    mapHistory.insert(string(tx, "tx_hash"), mapPurpose(transaction["extra"]));
                }
            }
        } catch (const Error &) { /* Keep wallet history available while the daemon catches up. */ }
    }
    QJsonArray latest;
    for (qsizetype i = 0; i < count; ++i) {
        auto &row = rows[i];
        const auto purpose = mapHistory.value(row["id"].toString());
        for (auto field = purpose.begin(); field != purpose.end(); ++field) row.insert(field.key(), field.value());
        latest.append(row);
    }
    state.insert("history", latest);
    return state;
}

QJsonObject WalletService::networkPeers()
{
    if (!daemon) throw Error(ui("Node is off"));
    QJsonArray connections, operators;
    const auto response = daemon->call("get_connections");
    const auto peers = response.FindMember("connections");
    if (peers != response.MemberEnd() && peers->value.IsArray()) {
        for (const auto &entry : peers->value.GetArray()) {
            if (!entry.IsObject()) continue;
            connections.append(QJsonObject{{"address", string(entry, "address")}, {"incoming", flag(entry, "incoming")},
                {"height", QString::number(number(entry, "height"))}, {"peer", string(entry, "peer_id")}});
        }
    }
    QJsonObject result{{"connections", connections}};
    try {
        const auto roster = daemon->call("get_note_operator_roster");
        const auto entries = roster.FindMember("operators");
        if (entries != roster.MemberEnd() && entries->value.IsArray()) {
            for (const auto &entry : entries->value.GetArray()) {
                if (!entry.IsObject()) continue;
                operators.append(QJsonObject{{"endpoint", string(entry, "url")}, {"identity", string(entry, "identity")},
                    {"expires", QString::number(number(entry, "expires"))}});
            }
        }
        result.insert("operators", operators);
        result.insert("threshold", int(number(roster, "threshold")));
    } catch (const Error &) {
        result.insert("operatorRosterUnavailable", true);
    }
    return result;
}

QJsonArray WalletService::addressBook()
{
    requireWallet();
    const auto response = wallet->call("get_address_book");
    QJsonArray book;
    const auto entries = response.FindMember("entries");
    if (entries == response.MemberEnd() || !entries->value.IsArray()) return book;
    for (const auto &entry : entries->value.GetArray()) {
        if (!entry.IsObject()) continue;
        book.append(QJsonObject{{"index", qint64(number(entry, "index"))}, {"address", string(entry, "address")},
            {"description", string(entry, "description")}});
    }
    return book;
}

QJsonArray WalletService::saveContact(const QString &recipient, const QString &description)
{
    requireWallet();
    const auto valid = wallet->call("validate_address", {{"address", recipient}, {"any_net_type", false}, {"allow_openalias", false}});
    if (!flag(valid, "valid")) throw Error(ui("Check the recipient's Noticoin address."));
    const auto book = addressBook();
    for (const auto &entry : book) {
        const auto contact = entry.toObject();
        if (contact["address"].toString() != recipient) continue;
        const bool changed = contact["description"].toString() != description;
        if (changed) {
            wallet->call("edit_address_book", {{"index", contact["index"]}, {"set_address", false},
                {"set_description", true}, {"description", description}});
        }
        wallet->call("store");
        return changed ? addressBook() : book;
    }
    wallet->call("add_address_book", {{"address", recipient}, {"description", description}});
    wallet->call("store");
    return addressBook();
}

QJsonObject WalletService::close()
{
    if (active.isEmpty()) return {};
    wallet->call("store");
    wallet->call("close_wallet");
    active.clear();
    address.clear();
    mapHistory.clear();
    discard();
    return {};
}

void WalletService::shutdown()
{
    close();
    if (daemon && !regtestPort) try { daemon->call("stop_daemon", {}, false); } catch (...) {}
    stopProcess(walletProcess);
    stopProcess(daemonProcess);
}

QString WalletService::seed()
{
    requireWallet();
    return string(wallet->call("query_key", {{"key_type", "mnemonic"}}), "key");
}

QString WalletService::subaddress()
{
    requireWallet();
    auto sub = string(wallet->call("create_address", {{"account_index", 0}, {"label", "Noticoin Wallet"}}), "address");
    wallet->call("store");
    return sub;
}

QJsonObject WalletService::donationAddresses(bool create)
{
    requireWallet();
    const auto selected = create ? subaddress() : QString{};
    auto choices = subaddresses();
    choices.prepend(QJsonObject{{"index", 0}, {"address", address}});
    return {{"addresses", choices}, {"selected", selected}};
}

QJsonArray WalletService::mapNoteAddresses(int count)
{
    requireWallet();
    if (count < 1 || count > 100) throw Error(ui("Invalid note edition size."));
    const auto result = wallet->call("create_address", {{"account_index", 0}, {"count", count}, {"label", "Noticoin map note"}});
    const auto addresses = result.FindMember("addresses");
    if (addresses == result.MemberEnd() || !addresses->value.IsArray() ||
        addresses->value.Size() != static_cast<unsigned>(count))
        throw Error(ui("Could not create note payment addresses."));
    QJsonArray values;
    for (const auto &address : addresses->value.GetArray()) {
        if (!address.IsString()) throw Error(ui("Could not create note payment addresses."));
        values.append(QString::fromUtf8(address.GetString(), address.GetStringLength()));
    }
    wallet->call("store");
    return values;
}

qint64 WalletService::nextMapPublicationHeight()
{
    requireWallet();
    const auto info = daemon->call("get_info");
    const auto height = number(info, "height");
    if (height == 0 || flag(info, "busy_syncing") || number(info, "target_height") > height ||
        (!regtest && !regtestPort && !flag(info, "synchronized")))
        throw Error(ui("The node is still synchronizing."));
    return static_cast<qint64>(height);
}

QJsonValue WalletService::mapNoteRegistryPolicy(qint64 height)
{
    const auto nextHeight = nextMapPublicationHeight();
    if (height < 0 || height > nextHeight) throw Error(ui("Invalid note operator roster height."));
    const auto roster = daemon->call("get_note_operator_roster", {{"height", height}});
    const auto operators = roster.FindMember("operators");
    const auto threshold = number(roster, "threshold");
    if (!threshold || operators == roster.MemberEnd() || !operators->value.IsArray()) return QJsonValue::Null;
    QJsonArray keys;
    for (const auto &entry : operators->value.GetArray())
        keys.append(string(entry, "key"));
    return QJsonObject{{"height", static_cast<qint64>(number(roster, "epoch"))},
        {"threshold", static_cast<qint64>(threshold)}, {"keys", keys}, {"registry", true}};
}

namespace {
QJsonObject mapPaymentProofArguments(const QJsonObject &request)
{
    const auto txid = request["txid"].toString();
    const auto address = request["address"].toString();
    const auto message = request["paymentMessage"].toString();
    static const QRegularExpression txFormat("^[a-f0-9]{64}$");
    static const QRegularExpression addressFormat("^[1-9A-HJ-NP-Za-km-z]{95,106}$");
    static const QRegularExpression messageFormat(R"(^noti-note-v2:[a-f0-9-]{36}:[a-f0-9-]{36}:(?:noti|\x6b\x6f\x6b\x6f)-recipient-v1\.[A-Za-z0-9_-]{563}$)");
    if (!txFormat.match(txid).hasMatch() || !addressFormat.match(address).hasMatch() || !messageFormat.match(message).hasMatch())
        throw Error(ui("Invalid note payment proof."));
    return {{"txid", txid}, {"address", address}, {"message", message}};
}
bool senderProof(const QString &signature)
{
    return signature.startsWith("OutProofV1") || signature.startsWith("OutProofV2");
}
}

QString WalletService::signMapNotePayment(const QJsonObject &request)
{
    requireWallet();
    const auto proof = string(wallet->call("get_tx_proof", mapPaymentProofArguments(request)), "signature");
    if (!senderProof(proof)) throw Error(ui("Invalid note payment proof."));
    return proof;
}

bool WalletService::verifyMapNotePayment(const QJsonObject &request)
{
    requireWallet();
    auto args = mapPaymentProofArguments(request);
    const auto proof = request["proof"].toString();
    const auto address = args["address"].toString();
    const auto addresses = subaddresses();
    if (!senderProof(proof) || proof.size() > 4096 || std::none_of(addresses.begin(), addresses.end(), [&](const auto &row) {
        return row.toObject()["address"].toString() == address;
    })) return false;
    bool validAmount = false;
    const auto expected = request["amountAtomic"].toString().toULongLong(&validAmount);
    if (!validAmount || expected < 10000000) return false;
    args.insert("signature", proof);
    const auto check = wallet->call("check_tx_proof", args);
    return flag(check, "good") && !flag(check, "in_pool") && number(check, "confirmations") >= 3 && number(check, "received") >= expected;
}

QJsonArray WalletService::subaddresses()
{
    requireWallet();
    const auto result = wallet->call("get_address", {{"account_index", 0}});
    QJsonArray list;
    if (!result.HasMember("addresses") || !result["addresses"].IsArray()) return list;
    for (const auto &item : result["addresses"].GetArray()) {
        if (!item.IsObject()) continue;
        const auto index = number(item, "address_index");
        const auto value = string(item, "address");
        if (!index || value.isEmpty()) continue;
        list.append(QJsonObject{{"index", qint64(index)}, {"address", value}, {"used", flag(item, "used")}});
    }
    return list;
}

QJsonObject WalletService::estimateMaximum(int priority)
{
    requireWallet();
    if (priority < 1 || priority > 4) throw Error(ui("Choose a transfer priority."));
    const auto estimate = daemon->call("get_fee_estimate", {{"grace_blocks", 10}});
    const auto rates = estimate.FindMember("fees");
    const auto index = rapidjson::SizeType(priority - 1);
    if (rates == estimate.MemberEnd() || !rates->value.IsArray() || rates->value.Size() <= index || !rates->value[index].IsUint64())
        throw Error(ui("Fee estimate unavailable."));
    const auto rate = rates->value[index].GetUint64();
    const auto mask = number(estimate, "quantization_mask");

    const auto weight = [this](int inputs) {
        return number(wallet->call("estimate_tx_size_and_weight", {{"n_inputs", inputs}, {"n_outputs", 2}}), "weight");
    };
    // The sweep builder aims for two thirds of the wallet transaction-weight limit on the current fork.
    constexpr quint64 targetWeight = (300000 / 2 - 600) * 2 / 3;
    const auto one = weight(1), two = weight(2);
    if (one == 0 || one >= targetWeight || two <= one || rate == 0 || mask == 0)
        throw Error(ui("Fee estimate unavailable."));
    const auto perInput = two - one;
    const auto maxInputs = 1 + (targetWeight - one + perInput - 1) / perInput;
    const auto available = wallet->call("incoming_transfers", {{"transfer_type", "available"}, {"account_index", 0}});
    const auto outputs = available.FindMember("transfers");
    if (outputs == available.MemberEnd() || !outputs->value.IsArray())
        throw Error(ui("Fee estimate unavailable."));
    quint64 inputs = 0, balance = 0;
    for (const auto &output : outputs->value.GetArray()) {
        if (!output.IsObject() || !flag(output, "unlocked") || flag(output, "frozen")) continue;
        const auto amount = number(output, "amount");
        // Standard wallets omit outputs whose value is below what they cost to spend.
        if (amount / rate < perInput) continue;
        balance += amount;
        ++inputs;
    }
    if (!inputs) return {{"amount", "0"}, {"fee", "0"}};

    const auto roundedFee = [=](quint64 count) {
        const auto txWeight = one + (count - 1) * perInput;
        if (rate > (std::numeric_limits<quint64>::max() - mask) / txWeight)
            throw Error(ui("Fee estimate unavailable."));
        return (txWeight * rate + mask - 1) / mask * mask;
    };
    const auto batches = inputs / maxInputs;
    const auto remainder = inputs % maxInputs;
    const auto fullFee = roundedFee(maxInputs);
    const auto lastFee = remainder ? roundedFee(remainder) : 0;
    if (fullFee && batches > (std::numeric_limits<quint64>::max() - lastFee) / fullFee)
        throw Error(ui("Fee estimate unavailable."));
    const auto fee = batches * fullFee + lastFee;
    return {{"amount", money(balance > fee ? balance - fee : 0)}, {"fee", money(fee)}};
}

QJsonObject WalletService::prepare(const QString &recipient, const QString &amount, bool maximum, const QString &mapRecord,
                                   TransferPurpose purpose, int priority)
{
    requireWallet();
    discard();
    if (priority < 1 || priority > 4) throw Error(ui("Choose a transfer priority."));
    const auto valid = wallet->call("validate_address", {{"address", recipient}, {"any_net_type", false}, {"allow_openalias", false}});
    if (!flag(valid, "valid")) throw Error(ui("Check the recipient's Noticoin address."));
    if (purpose == TransferPurpose::MapDonation) {
        bool ownAddress = true;
        try { wallet->call("get_address_index", {{"address", recipient}}); }
        catch (const RpcRejected &error) {
            // Wallet RPC reports a valid address outside this wallet with WRONG_ADDRESS (-2).
            if (error.code != -2) throw;
            ownAddress = false;
        }
        if (ownAddress) throw Error(ui("You cannot donate to your own wallet."));
    }
    quint64 coins = 0, fee = 0;
    const auto add = [](quint64 &total, quint64 value) {
        if (value > std::numeric_limits<quint64>::max() - total) throw Error(ui("The total amount is too large."));
        total += value;
    };
    QStringList preparedDraft;
    if (maximum) {
        const auto prepared = wallet->call("sweep_all", {{"address", recipient}, {"account_index", 0},
            {"subaddr_indices_all", true}, {"priority", priority}, {"do_not_relay", true}, {"get_tx_metadata", true}});
        const auto metadata = prepared.FindMember("tx_metadata_list");
        const auto amounts = prepared.FindMember("amount_list");
        const auto fees = prepared.FindMember("fee_list");
        if (metadata == prepared.MemberEnd() || !metadata->value.IsArray() || metadata->value.Empty()
            || amounts == prepared.MemberEnd() || !amounts->value.IsArray() || amounts->value.Size() != metadata->value.Size()
            || fees == prepared.MemberEnd() || !fees->value.IsArray() || fees->value.Size() != metadata->value.Size())
            throw Error(ui("The wallet did not prepare the transfer."));
        for (rapidjson::SizeType i = 0; i < metadata->value.Size(); ++i) {
            const auto &hex = metadata->value[i];
            const auto &value = amounts->value[i];
            const auto &charge = fees->value[i];
            if (!hex.IsString() || !hex.GetStringLength() || !value.IsUint64() || !charge.IsUint64())
                throw Error(ui("The wallet did not prepare the transfer."));
            add(coins, value.GetUint64());
            add(fee, charge.GetUint64());
            preparedDraft << QString::fromLatin1(hex.GetString(), hex.GetStringLength());
        }
    } else {
        coins = parseMoney(amount);
        auto args = "{\"destinations\":[{\"address\":" + literal(recipient) + ",\"amount\":" + QByteArray::number(coins)
            + "}],\"account_index\":0,\"priority\":" + QByteArray::number(priority) + ",\"do_not_relay\":true,\"get_tx_metadata\":true";
        if (!mapRecord.isEmpty()) args += ",\"get_tx_hex\":true,\"map_record\":" + literal(mapRecord);
        const auto prepared = wallet->request("transfer", args + "}");
        if (!mapRecord.isEmpty() && !string(prepared, "tx_blob").contains("0276" + mapRecord))
            throw Error(ui("The wallet did not include the map record."));
        fee = number(prepared, "fee");
        const auto hex = string(prepared, "tx_metadata");
        if (hex.isEmpty()) throw Error(ui("The wallet did not prepare the transfer."));
        if (purpose == TransferPurpose::MapPurchase) {
            draftPurchaseId = string(prepared, "tx_hash");
            if (draftPurchaseId.size() != 64) throw Error(ui("The wallet did not prepare the transfer."));
        }
        preparedDraft << hex;
    }
    quint64 total = coins;
    add(total, fee);
    draft = std::move(preparedDraft);
    return {{"recipient", recipient}, {"amount", money(coins)}, {"fee", money(fee)}, {"total", money(total)},
        {"transactions", draft.size()}};
}

QJsonObject WalletService::relay()
{
    requireWallet();
    if (draft.isEmpty()) throw Error(ui("Prepare a transfer first."));
    const auto prepared = std::exchange(draft, QStringList());
    const auto purchaseId = std::exchange(draftPurchaseId, QString());
    QJsonArray ids;
    if (!purchaseId.isEmpty()) {
        wallet->call("set_tx_notes", {{"txids", QJsonArray{purchaseId}}, {"notes", QJsonArray{mapPurchaseNote}}});
        wallet->call("store");
    }
    for (const auto &hex : prepared) {
        try {
            const auto id = string(wallet->call("relay_tx", {{"hex", hex}}), "tx_hash");
            if (id.size() != 64) throw Error(ui("Could not confirm that the transfer was sent."));
            ids.append(id);
        } catch (const std::exception &error) {
            return {{"ids", ids}, {"error", QString::fromUtf8(error.what())}};
        }
    }
    return {{"ids", ids}};
}

void WalletService::discard()
{
    draft.clear();
    draftPurchaseId.clear();
}

QJsonObject WalletService::verify()
{
    if (parseMoney("18446744073.709551615") != std::numeric_limits<quint64>::max()
        || money(parseMoney("0,000000001")) != "0.000000001"
        || parseMoney("0.1") != 100000000) throw Error(ui("The amount lost precision."));
    const QString senderPassword = "x";
    open("sender", senderPassword, "create", {}, 0, "Russian");
    const auto source = address, words = seed();
    close();
    open("restored", {}, "restore", words, 1);
    if (source != address) throw Error(ui("Restoring produced a different address."));
    close();
    open("restored", {}, "open");
    if (source != address) throw Error(ui("Restoring produced a different address."));
    close();
    open("receiver", {}, "create");
    const auto receiverAddress = address;
    const auto recipient = subaddress();
    close();
    bool denied = false;
    try { open("sender", "incorrect-password", "open"); }
    catch (const Error &) { denied = true; }
    if (!denied || !active.isEmpty()) throw Error(ui("The wallet opened with an invalid password."));
    open("receiver", {}, "open");
    denied = false;
    try { open("sender", "incorrect-password", "open"); }
    catch (const Error &) { denied = true; }
    const auto unchanged = snapshot(false, true);
    const auto unchangedAddresses = unchanged["subaddresses"].toArray();
    if (!denied || unchanged["wallet"].toString() != "receiver" || unchanged["address"].toString() != receiverAddress
        || unchangedAddresses.size() != 1 || unchangedAddresses.first().toObject()["address"].toString() != recipient)
        throw Error("An invalid wallet switch replaced the active wallet");
    const auto switched = open("sender", senderPassword, "open");
    if (switched["wallet"].toString() != "sender" || switched["address"].toString() != source
        || !switched["subaddresses"].toArray().isEmpty())
        throw Error("A wallet switch returned data from the previous wallet");
    if (saveContact(recipient, "Test contact").size() != 1) throw Error("Address book did not save the contact");
    const auto renamed = saveContact(recipient, "Regtest recipient");
    if (renamed.size() != 1 || renamed.first().toObject()["description"].toString() != "Regtest recipient")
        throw Error("Saving the same address did not update the contact");
    const auto peers = networkPeers();
    if (!peers["connections"].isArray() || !peers["operators"].isArray()) throw Error("Peer or note operator list unavailable");
    const auto donation = donationAddresses(true);
    const auto donationChoices = donation["addresses"].toArray();
    const auto generated = donation["selected"].toString();
    if (generated.isEmpty() || donationChoices.size() != 2 || donationChoices.first()["address"].toString() != source
        || donationChoices.last()["address"].toString() != generated)
        throw Error("The donation picker did not return the primary address and new subaddress");
    for (const auto &own : {source, generated}) {
        bool selfDonationBlocked = false;
        try { prepare(own, "0.1", false, {}, TransferPurpose::MapDonation); }
        catch (const Error &error) { selfDonationBlocked = QString::fromUtf8(error.what()) == ui("You cannot donate to your own wallet."); }
        if (!selfDonationBlocked) throw Error("The wallet did not reject a donation to its own address");
    }
    const auto mine = [this, &source](int blocks) {
        daemon->call("generateblocks", {{"wallet_address", source}, {"amount_of_blocks", blocks}});
        wallet->call("refresh");
    };
    mine(190);
    if (!snapshot(false, false, true)["incoming"].toArray().isEmpty())
        throw Error("Mining rewards were reported as incoming transfers");
    QJsonArray priorityFees;
    quint64 previousFee = 0;
    for (int priority = 1; priority <= 4; ++priority) {
        const auto fee = prepare(recipient, "0.1", false, {}, TransferPurpose::Regular, priority)["fee"].toString();
        const auto atomic = parseMoney(fee);
        if (atomic <= previousFee) throw Error("Higher transfer priority did not raise the fee");
        priorityFees.append(fee);
        previousFee = atomic;
    }
    prepare(recipient, "0.1", false, {}, TransferPurpose::MapDonation);
    discard();
    const auto target = number(daemon->call("get_info"), "target");
    if (target != 45) throw Error("Unexpected block target");
    // A deterministic test signature over a map publication record.
    const auto fixture = QStringLiteral("4e544d5001010c16b729428b4e59b02ab43e63a12b0f31debe55d37c722768b137131caa6087080b2e0b60b94bd785d14575cfa498bc48dd753da2b62dd4575b8dc4d04f24d4d7772e9249c4c7f5bc939c5f099a5c476e23532c34e1e25fe4762401c501353dc3228c45ac17e9c5dc1ff46b86c07509");
    const auto quote = prepare(recipient, "0.1", false, fixture);
    const auto pool = daemon->call("get_transaction_pool", {}, false);
    if (pool.HasMember("transactions") && pool["transactions"].IsArray() && !pool["transactions"].Empty())
        throw Error(ui("Preparing the transfer sent it without confirmation."));
    QElapsedTimer timer;
    timer.start();
    const auto ids = relay()["ids"].toArray();
    if (ids.size() != 1) throw Error(ui("The transfer was not sent."));
    const auto relayMs = timer.elapsed();
    const auto txid = ids.first().toString();
    const auto paymentMessage = QStringLiteral("noti-note-v2:c24c709b-6761-4208-ae87-f4928276ad48:0c16b729-428b-4e59-b02a-b43e63a12b0f:noti-recipient-v1.") + QString(563, QChar('A'));
    QJsonObject paymentProof{{"txid", txid}, {"address", recipient}, {"paymentMessage", paymentMessage}, {"amountAtomic", "100000000"}};
    paymentProof.insert("proof", signMapNotePayment(paymentProof));
    const auto checkTransfer = [&txid, &recipient, &quote](const QJsonObject &state, const QString &kind, int confirmations) {
        for (const auto &row : state["history"].toArray()) {
            const auto tx = row.toObject();
            if (tx["id"].toString() == txid && tx["kind"].toString() == kind
                && tx["confirmations"].toInt(-1) == confirmations && tx["amount"].toString() == "0.1") {
                if (!tx["addresses"].toArray().contains(recipient)
                    || (kind == "pending" && tx["fee"].toString() != quote["fee"].toString())
                    || (confirmations > 0 && tx["height"].toInteger() <= 0))
                    throw Error("Transaction details are incomplete");
                if (tx["mapOperation"].toString() != "publish" || tx["mapPoint"].toString() != "0c16b729-428b-4e59-b02a-b43e63a12b0f")
                    throw Error("Wallet history did not read the verified on-chain map record");
                return;
            }
        }
        throw Error(QString("Expected %1 with %2 confirmations in wallet history").arg(kind).arg(confirmations));
    };
    checkTransfer(snapshot(true), "pending", 0);
    open("receiver", {}, "open");
    if (!addressBook().isEmpty()) throw Error("Contacts leaked between wallets");
    wallet->call("refresh");
    checkTransfer(snapshot(true), "pool", 0);
    const auto checkIncoming = [this, &txid](bool pooled) {
        for (const auto &entry : snapshot(false, false, true)["incoming"].toArray()) {
            const auto tx = entry.toObject();
            if (tx["id"].toString() == txid && tx["amount"].toString() == "0.1" && tx["pooled"].toBool() == pooled) return;
        }
        throw Error("Incoming payments were missing from the non-history snapshot");
    };
    checkIncoming(true);
    const auto nextHeight = number(daemon->call("get_info"), "height") + 1;
    daemon->call("generateblocks", {{"wallet_address", source}, {"amount_of_blocks", 1}});
    timer.restart();
    while (number(wallet->call("get_height"), "height") < nextHeight && timer.elapsed() < 15000)
        QThread::msleep(250);
    checkTransfer(snapshot(true), "in", 1);
    checkIncoming(false);
    const auto walletAutoRefreshMs = timer.elapsed();
    const int spendableAge = noticoin::network::spendableAgeBlocks;
    mine(spendableAge - 2);
    const auto locked = snapshot(true);
    checkTransfer(locked, "in", spendableAge - 1);
    if (locked["balance"].toString() != "0.1" || locked["available"].toString() != "0")
        throw Error("Transfer unlocked before the required confirmations");
    mine(1);
    const auto received = snapshot(true, true);
    if (!verifyMapNotePayment(paymentProof)) throw Error("The seller wallet could not independently verify the purchase");
    auto otherKeyProof = paymentProof;
    otherKeyProof.insert("paymentMessage", paymentMessage.chopped(1) + "B");
    if (verifyMapNotePayment(otherKeyProof)) throw Error("The same purchase was accepted for a different recipient");
    checkTransfer(received, "in", spendableAge);
    if (received["available"].toString() != "0.1") throw Error("Transfer did not unlock at the required confirmations");
    const auto addresses = received["subaddresses"].toArray();
    if (addresses.size() != 1 || addresses.first().toObject()["address"].toString() != recipient)
        throw Error("Saved subaddress missing after reopening");
    prepare(source, "0.05", false, {}, TransferPurpose::MapPurchase);
    const auto onwardIds = relay()["ids"].toArray();
    if (onwardIds.size() != 1) throw Error("Could not spend the newly unlocked funds");
    const auto onwardId = onwardIds.first().toString();
    const auto checkPurchaseLabel = [this, &onwardId](const char *state) {
        for (const auto &entry : snapshot(true)["history"].toArray()) {
            const auto transfer = entry.toObject();
            if (transfer["id"].toString() == onwardId && transfer["kind"].toString() == state && transfer["mapPurchase"].toBool()) return;
        }
        throw Error("The wallet history did not classify the note purchase");
    };
    checkPurchaseLabel("pending");
    mine(1);
    const auto onward = wallet->call("get_transfer_by_txid", {{"txid", onwardId}});
    if (!onward.HasMember("transfer") || string(onward["transfer"], "type") != "out")
        throw Error("The onward spend did not reach a block");
    close();
    open("receiver", {}, "open");
    checkPurchaseLabel("out");
    open("sender", senderPassword, "open");
    wallet->call("refresh");
    const auto savedBook = addressBook();
    if (savedBook.size() != 1 || savedBook.first().toObject()["address"].toString() != recipient
        || savedBook.first().toObject()["description"].toString() != "Regtest recipient")
        throw Error("Address book did not persist across wallet switches");
    const auto selfQuote = prepare(generated, "21", false, {}, TransferPurpose::Regular, 4);
    const auto selfIds = relay()["ids"].toArray();
    if (selfIds.size() != 1) throw Error("Could not relay the test transfer to an owned subaddress");
    const auto selfId = selfIds.first().toString();
    const auto checkSelf = [this, &selfId, &selfQuote, &generated](const QString &kind) {
        for (const auto &entry : snapshot(true)["history"].toArray()) {
            const auto row = entry.toObject();
            if (row["id"].toString() == selfId && row["kind"].toString() == kind &&
                row["selfTransfer"].toBool() && row["amount"].toString() == "21" &&
                row["fee"].toString() == selfQuote["fee"].toString() && row["addresses"].toArray().contains(generated)) return;
        }
        throw Error("History lost the amount sent to the wallet's own subaddress");
    };
    checkSelf("pending");
    mine(1);
    checkSelf("out");
    timer.restart();
    const auto preview = estimateMaximum(2);
    const auto previewMs = timer.elapsed();
    const auto sweep = prepare(recipient, {}, true, {}, TransferPurpose::Regular, 2);
    if (sweep["total"].toString() != snapshot()["available"].toString()
        || parseMoney(sweep["amount"].toString()) + parseMoney(sweep["fee"].toString()) != parseMoney(sweep["total"].toString()))
        throw Error("Maximum does not account for the exact network fee");
    const auto feeEstimate = parseMoney(preview["fee"].toString()), exactFee = parseMoney(sweep["fee"].toString());
    if (!feeEstimate || feeEstimate > exactFee * 2 || exactFee > feeEstimate * 2 ||
        parseMoney(preview["amount"].toString()) + feeEstimate != parseMoney(sweep["total"].toString()))
        throw Error("Maximum preview did not approximate the spendable funds and fee");
    const auto unrelayed = daemon->call("get_transaction_pool", {}, false);
    if (unrelayed.HasMember("transactions") && unrelayed["transactions"].IsArray() && !unrelayed["transactions"].Empty())
        throw Error("Preparing the maximum relayed a transaction");
    discard();
    const auto reviewed = prepare(recipient, {}, true);
    const auto sent = relay();
    if (sent.contains("error") || sent["ids"].toArray().size() != reviewed["transactions"].toInt())
        throw Error("Maximum transfer was not relayed");
    shutdown();
    return {{"blockTargetSeconds", qint64(target)}, {"transactionId", txid}, {"amountNoticoin", "0.1"},
        {"selfTransferHistory", true}, {"maximumFeePreviewMs", previewMs},
        {"walletSwitchWithPassword", true}, {"wrongSwitchPasswordKeepsWallet", true},
        {"donationAddressPicker", true}, {"selfDonationBlocked", true}, {"purchaseHistoryAfterReopening", true},
        {"feePriorities", priorityFees}, {"addressBookPersisted", true}, {"incomingPaymentWithoutHistory", true}, {"networkPeerLists", true},
        {"senderProofVerifiedBySeller", true}, {"wrongRecipientRejected", true},
        {"feeNoticoin", quote["fee"]}, {"walletRelayMs", relayMs}, {"walletAutoRefreshMs", walletAutoRefreshMs},
        {"receiverConfirmations", QJsonArray{0, 1, spendableAge - 1, spendableAge}},
        {"unlockedAtConfirmations", spendableAge}, {"onwardTransactionId", onwardId},
        {"maximumTransferFeeNoticoin", reviewed["fee"]}};
}
}
