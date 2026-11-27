#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QMainWindow>
#include <QSet>
#include <QThread>
#include <functional>
#include <memory>
#include <vector>

class QLabel;
class QJsonArray;
class QPushButton;
class QLineEdit;
class QComboBox;
class QPlainTextEdit;
class QStackedWidget;
class QTableWidget;
class QTimer;
class QUrl;
class QVBoxLayout;

namespace noticoin {
class WalletService;
class MapView;
enum class TransferPurpose;
class WalletWindow : public QMainWindow {
public:
    WalletWindow(QString root, QString data, quint16 regtestPort = 0);
    ~WalletWindow() override;
protected:
    void closeEvent(QCloseEvent *event) override;
private:
    enum Page { Overview, Send, Receive, History, World, Wallets, Node };
    enum class AccessRoute { Startup, Workspace, Setup, Switch };
    void showPage(Page page);
    void transact(QString label, std::function<QJsonValue(WalletService &)> work,
                  std::function<void(QJsonValue)> ready = {}, bool showErrors = true,
                  std::function<void(const QString &)> failed = {});
    void updateState(const QJsonObject &state);
    void mapWalletRequest(const QJsonObject &request);
    void updateRecent(const QJsonArray &entries);
    void showTransaction(const QJsonObject &transaction);
    void updateSubaddresses(const QJsonArray &entries);
    void setReceiveAddress(const QString &address, bool subaddress = false);
    void copyAddress(const QString &address);
    void refresh();
    void startup();
    void chooseLanguage();
    void applyAppearance();
    QPushButton *themeButton(bool compact = false);
    void chooseWalletAction();
    void walletAccess(const QString &mode, AccessRoute route = AccessRoute::Workspace, const QString &target = {});
    QVBoxLayout *accessPanel(const QString &title, const QString &description = {},
                            bool languagePicker = false, bool exitButton = false);
    void openWorkspace(Page page, const QJsonObject &state = {});
    void buildWorkspace();
    void showInitialBackup(const QJsonObject &state);
    void showSeed();
    void send();
    void setMaximum(bool enabled);
    void scheduleMaximumQuote();
    void quoteMaximum();
    void showAddressBook();
    void showPeers();
    void notifyIncoming(const QJsonObject &state, bool opening);
    void reviewTransfer(const QString &recipient, const QString &coins, bool sendAll,
                        bool fromMap = false, const QString &invoiceId = {}, const QString &mapRecord = {},
                        TransferPurpose purpose = {});
    void alert(const QString &title, const QString &message);
    void notify(const QString &message, int duration = 3200);
    void invoice(const QUrl &url);
    QWidget *overviewPage();
    QWidget *sendPage();
    QWidget *receivePage();
    QWidget *historyPage();
    QWidget *walletPage();
    QWidget *nodePage();
    void updateActions();
    QString root, data, activeWallet, publicAddress, receiveAddress, spendable;
    quint16 regtestPort;
    QThread workerThread;
    QObject *worker = nullptr;
    std::unique_ptr<WalletService> service;
    bool busy = false, closing = false, closeReady = false, maximum = false;
    bool light = false;
    quint64 maximumQuoteVersion = 0;
    qint64 incomingFromHeight = 0;
    QSet<QString> seenIncoming;
    QJsonArray savedSubaddresses;
    std::vector<QPushButton *> requiresWallet, requiresClosed, nav;
    QStackedWidget *stages;
    QWidget *workspace = nullptr, *accessPage = nullptr;
    QStackedWidget *pages;
    QWidget *mapPage;
    QLabel *pageTitle, *networkChip, *balance, *available, *nodeHeight, *nodePeers, *nodeState;
    QLabel *balanceDetail, *locked, *sendBalance, *receiveKind, *receiveQr, *subaddressesEmpty, *subaddressesHint;
    QLabel *maxHint, *feeQuote = nullptr;
    QLabel *notification = nullptr;
    QTimer *notificationTimer = nullptr;
    QLabel *overviewConnection, *overviewHeight, *recentEmpty;
    QVBoxLayout *recentRows;
    QPushButton *account, *setupOverview, *sendOverview, *receiveOverview;
    QPushButton *worldOverview;
    QPushButton *sendOpen, *receiveOpen, *primaryAddress, *maxButton;
    QPlainTextEdit *toAddress, *receiveField;
    QLineEdit *amount;
    QComboBox *feePriority;
    QTableWidget *history, *subaddressTable;
    QTimer *timer;
    QTimer *maximumQuoteTimer;
    MapView *map = nullptr;
};
}
