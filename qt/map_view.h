#pragma once
#include <QWidget>
#include <QProcess>
#include <QUrl>
#include <QJsonObject>
#include <functional>

class QLabel;
class QHideEvent;
class QShowEvent;
class QResizeEvent;
struct ICoreWebView2Controller;

namespace noticoin {
class MapWebChannel;
class MapView : public QWidget {
public:
    MapView(QString root, QString data, const QString &walletAddress, bool regtest, std::function<void(QUrl)> invoice,
            std::function<void(QJsonObject)> walletRequest, QWidget *parent = nullptr);
    ~MapView() override;
    void start();
    void setLightTheme(bool light);
    void paymentSubmitted(const QString &invoiceId, const QString &txid);
    void donationSent(const QString &amount);
    void walletReply(const QString &id, const QJsonObject &reply);
protected:
    void showEvent(QShowEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;
private:
    void createRenderer();
#ifdef Q_OS_WIN
    void attach(ICoreWebView2Controller *view);
#endif
    void handleMapMessage(const QString &message);
    void postMapMessage(const QString &message);
    void revealAtlas();
    void syncTheme();
    void resizeRenderer();
    void fail(const QString &message);
    QString root, data, profile;
    QUrl origin;
    QByteArray serviceOutput;
    QProcess service;
    QLabel *notice;
    QWidget *preview;
    QWidget *host;
#ifdef Q_OS_WIN
    ICoreWebView2Controller *controller = nullptr;
#else
    MapWebChannel *channel = nullptr;
#endif
    std::function<void(QUrl)> invoice;
    std::function<void(QJsonObject)> walletRequest;
    bool started = false;
    bool atlasReady = false;
    bool light = false;
    bool regtest;
};
}
