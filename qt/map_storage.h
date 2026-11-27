#pragma once
#include <QByteArray>
#include <QString>

namespace noticoin {
QString prepareMapBrowserProfile(const QString &walletProfile);
QByteArray loadMapVaultSecret(const QString &walletProfile);
bool saveMapVaultSecret(const QString &walletProfile, const QByteArray &secret);
bool mapVaultSecretExists(const QString &walletProfile);
}
