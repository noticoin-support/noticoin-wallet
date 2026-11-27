#include "wallet_window.h"
#include "map_storage.h"
#include "wallet_service.h"
#include "wallet_ui.h"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QFont>
#include <QIcon>
#include <QJsonDocument>
#include <QLockFile>
#include <QMessageBox>
#include <QPalette>
#include <QSaveFile>
#include <QStandardPaths>
#include <cstdio>
#include <cstring>
#ifdef Q_OS_WIN
#include <windows.h>
#include <objbase.h>
#endif

int main(int argc, char **argv)
{
    if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
        std::puts("Noticoin Wallet " NOTICOIN_WALLET_VERSION);
        return 0;
    }
    QApplication app(argc, argv);
    app.setApplicationName("Noti Wallet");
    app.setApplicationVersion(NOTICOIN_WALLET_VERSION);
    app.setStyle("Fusion");
    auto font = app.font();
#ifdef Q_OS_WIN
    font.setFamily("Segoe UI");
#endif
    font.setPixelSize(15);
    app.setFont(font);
    QPalette palette = app.palette();
    palette.setColor(QPalette::Window, QColor("#0d1322"));
    palette.setColor(QPalette::WindowText, QColor("#eaf0ff"));
    palette.setColor(QPalette::Base, QColor("#0c1425"));
    palette.setColor(QPalette::AlternateBase, QColor("#131e33"));
    palette.setColor(QPalette::Text, QColor("#eaf0ff"));
    palette.setColor(QPalette::Button, QColor("#19233a"));
    palette.setColor(QPalette::ButtonText, QColor("#eaf0ff"));
    palette.setColor(QPalette::Highlight, QColor("#293d68"));
    palette.setColor(QPalette::HighlightedText, QColor("#f1f3ff"));
    palette.setColor(QPalette::PlaceholderText, QColor("#8c9ab5"));
    palette.setColor(QPalette::ToolTipBase, QColor("#18233a"));
    palette.setColor(QPalette::ToolTipText, QColor("#edf1ff"));
    app.setPalette(palette);
    const auto root = QCoreApplication::applicationDirPath();
    app.setWindowIcon(QIcon(":/brand/noticoin.png"));
    const auto args = app.arguments();
    if (args.size() == 3 && args[1] == "--self-test") {
        const auto data = QDir::cleanPath(QDir::current().absoluteFilePath(args[2]));
        QJsonObject result;
        int exitCode = 0;
        try {
            if (QFile::exists(data)) throw noticoin::Error(noticoin::ui("The self-test requires a new folder."));
            noticoin::WalletService service(root, data, true);
            result = service.verify();
            const QByteArray vaultKey("fixture-only Noti vault key");
            if (!noticoin::saveMapVaultSecret(data, vaultKey) || noticoin::loadMapVaultSecret(data) != vaultKey)
                throw noticoin::Error("The system could not protect and reopen the note key");
#ifdef Q_OS_WIN
            QFile protectedKey(data + "/note-vault.dpapi");
            if (!protectedKey.open(QIODevice::ReadOnly) || protectedKey.readAll().contains(vaultKey))
                throw noticoin::Error("The note key was saved without Windows protection");
            result.insert("noteVaultWindowsProtection", true);
#else
            QFile marker(data + "/note-vault.keyring");
            if (!marker.open(QIODevice::ReadOnly) || marker.readAll().contains(vaultKey))
                throw noticoin::Error("The Linux note key is not stored in the system keyring");
            result.insert("noteVaultSecretServiceProtection", true);
#endif
            result.insert("success", true);
            result.insert("checks", "Qt RPC, empty and one-character passwords, incorrect password rejection, password-protected wallet switching, recovery, persistent subaddresses and contacts, donation protection, map purchase history, signed map records, four fee priorities, fixed and maximum transfers, incoming payments without opening History, node peer and operator lists, output unlock, no relay before approval");
        } catch (const std::exception &error) {
            result = {{"success", false}, {"error", QString::fromUtf8(error.what())}};
            exitCode = 1;
        }
        if (!QFile::exists(data) && !QDir().mkpath(data)) return 1;
        QSaveFile report(data + "/result.json");
        if (report.open(QIODevice::WriteOnly)) {
            report.write(QJsonDocument(result).toJson());
            if (!report.commit()) return 1;
        } else return 1;
        return exitCode;
    }
#ifdef Q_OS_WIN
    const auto localData = qEnvironmentVariable("LOCALAPPDATA");
#else
    const auto localData = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
    if (localData.isEmpty()) return 1;
#endif
    auto data = localData + "/Noticoin/Wallet";
#ifdef Q_OS_WIN
    const auto previousData = localData + QStringLiteral("/KO" "KO/Wallet");
    const bool usePreviousData = !QDir(data).exists() && QDir(previousData).exists();
    if (usePreviousData) data = previousData;
#endif
    quint16 regtestPort = 0;
    bool secondRegtestWindow = false;
    if (args.value(1) == "--regtest") {
        bool validPort = false;
        regtestPort = args.value(3).toUShort(&validPort);
        secondRegtestWindow = args.size() == 5 && args[4] == "--second-window";
        if ((args.size() != 4 && !secondRegtestWindow) || args[2].isEmpty() || !validPort || regtestPort == 0) {
            QMessageBox::critical(nullptr, "Noti Wallet", "Usage: Noticoin-Wallet --regtest <directory> <RPC port> [--second-window]");
            return 1;
        }
        data = QDir(args[2]).absoluteFilePath("regtest-wallet");
        app.setApplicationName("Noti Wallet · Regtest");
    }
    if (!QDir().mkpath(data + noticoin::walletDirectory)) {
        QMessageBox::critical(nullptr, "Noti Wallet", noticoin::ui("Could not create the wallet folder."));
        return 1;
    }
    QLockFile regtestLock(data + "/instance.lock");
#ifdef Q_OS_WIN
    HANDLE instance = nullptr;
    bool locked = false;
    if (regtestPort) {
        // Wallet RPC still locks the encrypted wallet file independently in each window.
        locked = secondRegtestWindow || regtestLock.tryLock(0);
    } else {
        const auto mutexPrefix = usePreviousData ? QStringLiteral("Local\\KO" "KO-Wallet-")
                                               : QStringLiteral("Local\\Noticoin-Wallet-");
        const auto mutexName = mutexPrefix + qEnvironmentVariable("USERNAME");
        instance = CreateMutexW(nullptr, TRUE, mutexName.toStdWString().c_str());
        locked = instance && GetLastError() != ERROR_ALREADY_EXISTS;
    }
#else
    const bool locked = secondRegtestWindow || regtestLock.tryLock(0);
#endif
    if (!locked) {
#ifdef Q_OS_WIN
        if (instance) CloseHandle(instance);
#endif
        QMessageBox::information(nullptr, "Noti Wallet", noticoin::ui("Close the open Noticoin Wallet window first."));
        return 1;
    }
#ifdef Q_OS_WIN
    const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
#endif
    int code = 1;
    try {
        noticoin::WalletWindow window(root, data, regtestPort);
        window.show();
        code = app.exec();
    } catch (const std::exception &error) {
        QMessageBox::critical(nullptr, "Noti Wallet", QString::fromUtf8(error.what()));
    }
#ifdef Q_OS_WIN
    if (SUCCEEDED(com)) CoUninitialize();
    if (instance) CloseHandle(instance);
#endif
    return code;
}
