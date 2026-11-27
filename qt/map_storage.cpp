#ifdef __linux__
#include <libsecret/secret.h>
#endif
#include "map_storage.h"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTemporaryDir>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#endif

namespace noticoin {
#ifdef Q_OS_WIN
namespace {
bool copyStorage(const QDir &source, const QString &target)
{
    if (!source.exists()) return true;
    if (!QDir().mkpath(target)) return false;
    const auto entries = source.entryInfoList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
    for (const auto &entry : entries) {
        if (entry.fileName() == "LOCK" && entry.isFile()) continue;
        const auto path = target + '/' + entry.fileName();
        if (entry.isSymLink() || entry.isJunction()) return false;
        if (entry.isDir() ? !copyStorage(QDir(entry.filePath()), path) : !QFile::copy(entry.filePath(), path))
            return false;
    }
    return true;
}

DATA_BLOB blob(const QByteArray &value)
{
    return {DWORD(value.size()), reinterpret_cast<BYTE *>(const_cast<char *>(value.constData()))};
}
}

QString prepareMapBrowserProfile(const QString &walletProfile)
{
    const auto local = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
    if (local.isEmpty()) return {};
    const QDir profiles(local + "/NoticoinAtlas");
    const auto identity = QDir::cleanPath(QDir(walletProfile).absolutePath()).toCaseFolded().toUtf8();
    const auto key = QString::fromLatin1(QCryptographicHash::hash(identity, QCryptographicHash::Sha256).toHex().left(40));
    const auto destination = profiles.filePath(key);
    if (QFileInfo(destination).isDir()) return destination;
    if (!QDir().mkpath(profiles.path())) return {};

    // Keep the original profile and its saved localhost port. The two browser
    // stores contain the map signing identity and the encrypted note vault.
    const auto source = walletProfile + "/map-profile/EBWebView/Default";
    QTemporaryDir staging(profiles.filePath(".restore-XXXXXX"));
    if (!staging.isValid()) return {};
    for (const auto &name : {QStringLiteral("Local Storage"), QStringLiteral("IndexedDB")}) {
        if (!copyStorage(QDir(source + '/' + name), staging.filePath("EBWebView/Default/" + name))) return {};
    }
    if (!QDir().rename(staging.path(), destination)) return {};
    staging.setAutoRemove(false);
    return destination;
}

QByteArray loadMapVaultSecret(const QString &walletProfile)
{
    QFile file(walletProfile + "/note-vault.dpapi");
    if (!file.open(QIODevice::ReadOnly) || file.size() < 1 || file.size() > 8192) return {};
    const auto encrypted = file.readAll();
    auto data = blob(encrypted);
    DATA_BLOB clear{};
    if (!CryptUnprotectData(&data, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &clear)) return {};
    QByteArray secret(reinterpret_cast<const char *>(clear.pbData), qsizetype(clear.cbData));
    SecureZeroMemory(clear.pbData, clear.cbData);
    LocalFree(clear.pbData);
    return secret;
}

bool saveMapVaultSecret(const QString &walletProfile, const QByteArray &secret)
{
    if (secret.size() < 16 || secret.size() > 1024 || secret.contains('\0')) return false;
    auto clear = blob(secret);
    DATA_BLOB encrypted{};
    if (!CryptProtectData(&clear, L"Noti note vault", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &encrypted)) return false;
    QSaveFile file(walletProfile + "/note-vault.dpapi");
    const bool saved = file.open(QIODevice::WriteOnly)
        && file.write(reinterpret_cast<const char *>(encrypted.pbData), encrypted.cbData) == encrypted.cbData && file.commit();
    LocalFree(encrypted.pbData);
    return saved;
}

bool mapVaultSecretExists(const QString &walletProfile)
{
    return QFile::exists(walletProfile + "/note-vault.dpapi");
}
#else
namespace {
const SecretSchema vaultSchema = {"com.noticoin.NoteVault", SECRET_SCHEMA_NONE,
    {{"profile", SECRET_SCHEMA_ATTRIBUTE_STRING}, {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}}};

QByteArray vaultProfileId(const QString &walletProfile)
{
    const auto path = QFileInfo(walletProfile).canonicalFilePath();
    return QCryptographicHash::hash(path.toUtf8(), QCryptographicHash::Sha256).toHex();
}
}

QString prepareMapBrowserProfile(const QString &walletProfile)
{
    const auto storage = walletProfile + "/chromium";
    if (!QDir().mkpath(storage) ||
        !QFile::setPermissions(storage, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner))
        return {};
    return storage;
}

QByteArray loadMapVaultSecret(const QString &walletProfile)
{
    if (!QFileInfo(walletProfile).isDir()) return {};
    const auto identity = vaultProfileId(walletProfile);
    auto *protectedKey = secret_password_lookup_sync(&vaultSchema, nullptr, nullptr,
        "profile", identity.constData(), nullptr);
    if (!protectedKey) return {};
    const auto secret = QByteArray::fromBase64(protectedKey, QByteArray::AbortOnBase64DecodingErrors);
    secret_password_free(protectedKey);
    return secret;
}

bool saveMapVaultSecret(const QString &walletProfile, const QByteArray &secret)
{
    if (!QFileInfo(walletProfile).isDir() || secret.size() < 16 || secret.size() > 1024 || secret.contains('\0'))
        return false;
    const auto identity = vaultProfileId(walletProfile);
    auto encoded = secret.toBase64();
    const bool saved = secret_password_store_sync(&vaultSchema, SECRET_COLLECTION_DEFAULT, "Noticoin note vault",
        encoded.constData(), nullptr, nullptr, "profile", identity.constData(), nullptr);
    encoded.fill('\0');
    if (!saved) return false;
    QSaveFile marker(walletProfile + "/note-vault.keyring");
    return marker.open(QIODevice::WriteOnly) && marker.write("1\n") == 2 && marker.commit();
}

bool mapVaultSecretExists(const QString &walletProfile)
{
    return QFile::exists(walletProfile + "/note-vault.keyring");
}
#endif
}
