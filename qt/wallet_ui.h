#pragma once
#include <QString>

namespace noticoin {
void setWalletLanguage(const QString &root, const QString &language);
QString walletLanguage(const QString &language);
QString ui(const char *text);
}
