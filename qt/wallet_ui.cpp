#include "wallet_ui.h"
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStringList>

namespace noticoin {
namespace {
QJsonObject translations;
const QStringList languages{"en", "fr", "de", "zh", "ja"};

QJsonObject readLanguage(const QString &root, const QString &language)
{
    QFile file(root + "/qt/i18n." + language + ".json");
    return file.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(file.readAll()).object() : QJsonObject{};
}
}

QString walletLanguage(const QString &language)
{
    return languages.contains(language) ? language : QStringLiteral("en");
}

void setWalletLanguage(const QString &root, const QString &language)
{
    const auto selected = walletLanguage(language);
    translations = selected == "en" ? QJsonObject{} : readLanguage(root, selected);
}

QString ui(const char *text)
{
    const auto source = QString::fromUtf8(text);
    return translations.value(source).toString(source);
}
}
