#pragma once
#include <QHash>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QProcess>
#include <memory>
#include <stdexcept>
#include <rapidjson/document.h>

namespace noticoin {
using Document = rapidjson::Document;
enum class TransferPurpose { Regular, MapDonation, MapPurchase };
inline constexpr auto walletDirectory = "/wallets-v3";

class Error : public std::runtime_error {
public:
    explicit Error(const QString &message) : std::runtime_error(message.toUtf8().constData()) {}
};

QString money(quint64 amount);
quint64 parseMoney(QString input);

class Rpc {
public:
    Rpc(quint16 port, QString password);
    Document call(const QString &method, const QJsonObject &parameters = {}, bool jsonRpc = true);
    Document request(const QString &method, const QByteArray &parameters, bool jsonRpc = true);
private:
    QNetworkAccessManager network;
    quint16 port;
    QString password;
};

class WalletService {
public:
    WalletService(QString root, QString data, bool regtest = false, quint16 regtestPort = 0);
    ~WalletService();
    bool isOpen() const { return !active.isEmpty(); }
    QJsonObject open(const QString &name, const QString &password, const QString &mode,
                     const QString &seed = {}, qint64 restoreHeight = 0, const QString &seedLanguage = "English");
    QJsonObject snapshot(bool history = false, bool addresses = false, bool watchIncoming = false);
    QJsonObject networkPeers();
    QJsonArray addressBook();
    QJsonArray saveContact(const QString &recipient, const QString &description);
    QJsonArray subaddresses();
    QJsonObject close();
    void shutdown();
    QString seed();
    QString subaddress();
    QJsonObject donationAddresses(bool create);
    QJsonArray mapNoteAddresses(int count);
    qint64 nextMapPublicationHeight();
    QJsonValue mapNoteRegistryPolicy(qint64 height);
    QString signMapNotePayment(const QJsonObject &request);
    bool verifyMapNotePayment(const QJsonObject &request);
    QJsonObject estimateMaximum(int priority);
    QJsonObject prepare(const QString &recipient, const QString &amount, bool maximum = false, const QString &mapRecord = {},
                        TransferPurpose purpose = TransferPurpose::Regular, int priority = 1);
    QJsonObject relay();
    void discard();
    QJsonObject verify();
private:
    void start();
    void requireWallet() const;
    void lockAfterFailedOpen();
    QString root, data, walletDir, active, address;
    QStringList draft;
    QString draftPurchaseId;
    QHash<QString, QJsonObject> mapHistory;
    bool regtest;
    quint16 regtestPort;
    QProcess daemonProcess, walletProcess;
    std::unique_ptr<Rpc> daemon, wallet;
};
}
