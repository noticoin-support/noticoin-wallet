#include "map_view.h"
#include "map_storage.h"
#include <QCryptographicHash>
#include "wallet_ui.h"
#include <QApplication>
#include <QClipboard>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QImage>
#include <QJsonDocument>
#include <QLabel>
#include <QPainter>
#include <QPointer>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSettings>
#include <QStackedLayout>
#include <QTimer>
#include <QVBoxLayout>
#ifdef Q_OS_WIN
#include <atomic>
#include <windows.h>
#include <WebView2.h>
#endif

namespace noticoin {
namespace {
#ifdef Q_OS_WIN
template <typename Interface, typename... Args>
class Callback final : public Interface {
public:
    Callback(const wchar_t *guid, std::function<HRESULT(Args...)> callback) : callback(std::move(callback))
    {
        IIDFromString(guid, &id);
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override
    {
        if (!object) return E_POINTER;
        if (iid == id || iid == IID_IUnknown) {
            *object = static_cast<Interface *>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override
    {
        const auto remaining = --references;
        if (remaining == 0) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return callback(args...); }
private:
    IID id{};
    std::atomic<ULONG> references{1};
    std::function<HRESULT(Args...)> callback;
};

template <typename Interface, typename... Args, typename Function>
auto handler(const wchar_t *guid, Function function)
{
    return new Callback<Interface, Args...>(guid, std::function<HRESULT(Args...)>(std::move(function)));
}

QString takeWide(LPWSTR value)
{
    if (!value) return {};
    const auto text = QString::fromWCharArray(value);
    CoTaskMemFree(value);
    return text;
}

#endif

class AtlasPreview final : public QWidget {
public:
    explicit AtlasPreview(const QString &atlas) : atlas(atlas), world(atlas + "/globe.png"), sky(atlas + "/deep-space.jpg")
    {
#ifdef Q_OS_WIN
        setAttribute(Qt::WA_NativeWindow);
        setAttribute(Qt::WA_DontCreateNativeAncestors);
#endif
        setAccessibleName(ui("Loading world map"));
    }
    void setLightTheme(bool enabled)
    {
        light = enabled;
        sky.load(atlas + (light ? "/silver-nebula.jpg" : "/deep-space.jpg"));
        update();
    }
protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter painter(this);
        painter.setRenderHints(QPainter::Antialiasing | QPainter::SmoothPixmapTransform);
        const QRectF area = rect().adjusted(1, 1, -1, -1);
        painter.setClipRect(area);
        painter.fillRect(area, light ? QColor("#e7eefb") : QColor("#060914"));
        if (!sky.isNull()) {
            const auto fill = sky.size().scaled(area.size().toSize(), Qt::KeepAspectRatioByExpanding);
            painter.drawImage(QRectF(area.center() - QPointF(fill.width(), fill.height()) / 2, fill), sky);
        }
        const auto size = qMin(area.width() * .78, area.height() * .84);
        if (!world.isNull()) painter.drawImage(QRectF((width() - size) / 2, (height() - size) / 2, size, size), world);
        painter.setPen(light ? QColor("#34476b") : QColor("#d5e3fa"));
        painter.drawText(area.adjusted(18, 12, -16, -12), Qt::AlignBottom | Qt::AlignLeft, ui("World map · Natural Earth"));
    }
private:
    QString atlas;
    QImage world;
    QImage sky;
    bool light = false;
};
}

MapView::MapView(QString root, QString data, const QString &walletAddress, bool regtest, std::function<void(QUrl)> invoice,
                 std::function<void(QJsonObject)> walletRequest, QWidget *parent)
    : QWidget(parent), root(std::move(root)), data(std::move(data)),
      profile(this->data + "/map-wallets/" + QString::fromLatin1(QCryptographicHash::hash(walletAddress.toLatin1(), QCryptographicHash::Sha256).toHex())),
      invoice(std::move(invoice)), walletRequest(std::move(walletRequest)), regtest(regtest)
{
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    notice = new QLabel(this);
    notice->setAlignment(Qt::AlignCenter);
    notice->setWordWrap(true);
    notice->hide();
    layout->addWidget(notice);
    auto *stack = new QStackedLayout;
    stack->setStackingMode(QStackedLayout::StackAll);
    layout->addLayout(stack, 1);
    host = new QWidget(this);
#ifdef Q_OS_WIN
    host->setAttribute(Qt::WA_NativeWindow);
    host->setAttribute(Qt::WA_DontCreateNativeAncestors);
#endif
    host->setStyleSheet("background: #060914");
    preview = new AtlasPreview(this->root + "/map/public/atlas");
    stack->addWidget(host);
    stack->addWidget(preview);
    stack->setCurrentWidget(preview);
#ifdef Q_OS_WIN
    service.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *a) { a->flags |= CREATE_NO_WINDOW; });
#endif
    service.setStandardErrorFile(this->data + "/map-service.log", QIODevice::Append);
    connect(&service, &QProcess::errorOccurred, this, [this] { fail(service.errorString()); });
    connect(&service, &QProcess::readyReadStandardOutput, this, [this] {
        serviceOutput += service.readAllStandardOutput();
        static const QRegularExpression address(R"(Noticoin desktop map: (\d+))");
        const auto match = address.match(QString::fromUtf8(serviceOutput));
        if (!match.hasMatch() || origin.isValid()) return;
        origin = QUrl("http://127.0.0.1:" + match.captured(1) + "/");
        QSettings settings(profile + "/qt-map.ini", QSettings::IniFormat);
        settings.setValue("port", origin.port());
        createRenderer();
    });
    connect(&service, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this, [this] {
        if (!origin.isValid()) fail(ui("The map service stopped. See map-service.log for details."));
    });
}

MapView::~MapView()
{
#ifdef Q_OS_WIN
    if (controller) {
        controller->Close();
        controller->Release();
    }
#endif
    if (service.state() != QProcess::NotRunning) {
        service.kill();
        service.waitForFinished(1000);
    }
}

void MapView::start()
{
    if (started) return;
    started = true;
    auto env = QProcessEnvironment::systemEnvironment();
    env.remove("NODE_OPTIONS");
    env.remove("NOTI_REGTEST_VAULT");
    if (!QDir().mkpath(profile)) return fail(ui("Could not open the wallet folder."));
    QSettings settings(profile + "/qt-map.ini", QSettings::IniFormat);
    env.insert("PORT", settings.value("port", "0").toString());
    env.insert("NOTICOIN_MAP_DATA", data + "/map");
    QSettings walletSettings(data + "/wallet.ini", QSettings::IniFormat);
    env.insert("NOTICOIN_UI_LANG", walletLanguage(walletSettings.value("language").toString()));
    env.insert("NOTICOIN_UI_THEME", light ? "light" : "dark");
    service.setProcessEnvironment(env);
#ifdef Q_OS_WIN
    const auto node = root + "/bin/node.exe";
#else
    const auto node = root + "/bin/node";
#endif
    service.start(node, {root + "/map/scripts/desktop.mjs"});
    QTimer::singleShot(15000, this, [this] {
        if (!origin.isValid()) fail(ui("The map did not start. Extract the complete archive and try again."));
    });
}

void MapView::setLightTheme(bool enabled)
{
    if (light == enabled) return;
    light = enabled;
    static_cast<AtlasPreview *>(preview)->setLightTheme(light);
    host->setStyleSheet(light ? "background: #e7eefb" : "background: #060914");
    syncTheme();
}

void MapView::syncTheme()
{
    if (atlasReady) postMapMessage(light ? "theme-light" : "theme-dark");
}

void MapView::paymentSubmitted(const QString &invoiceId, const QString &txid)
{
    postMapMessage(QString("map-payment-submitted:") + invoiceId + ":" + txid);
}

void MapView::donationSent(const QString &amount)
{
    postMapMessage(QString("map-donation-sent:") + amount);
}

void MapView::walletReply(const QString &id, const QJsonObject &reply)
{
    const auto payload = QString::fromUtf8(QJsonDocument(reply).toJson(QJsonDocument::Compact));
    postMapMessage(QString("map-wallet-reply:") + id + ":" + payload);
}

#ifdef Q_OS_WIN
void MapView::postMapMessage(const QString &message)
{
    if (!controller) return;
    ICoreWebView2 *web = nullptr;
    if (SUCCEEDED(controller->get_CoreWebView2(&web)) && web) {
        web->PostWebMessageAsString(message.toStdWString().c_str());
        web->Release();
    }
}

void MapView::createRenderer()
{
    const auto storage = prepareMapBrowserProfile(profile);
    if (storage.isEmpty()) return fail(ui("Could not move the map storage. Your existing data is safe."));
    const auto packagedLoader = root + "/runtime/WebView2Loader.dll";
    const auto loader = QDir::toNativeSeparators(QFile::exists(packagedLoader)
        ? packagedLoader : root + "/WebView2Loader.dll").toStdWString();
    const auto module = LoadLibraryExW(loader.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) return fail(ui("WebView2Loader.dll is missing."));
    using Create = HRESULT (STDAPICALLTYPE *)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
        ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
    const auto create = reinterpret_cast<Create>(GetProcAddress(module, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!create) return fail(ui("The WebView2 component is damaged."));
    QPointer<MapView> self(this);
    auto *environment = handler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment *>(
        L"{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}", [self](HRESULT result, ICoreWebView2Environment *value) {
        if (!self) return S_OK;
        if (FAILED(result) || !value) {
            self->fail(ui("The map requires Microsoft Edge WebView2 Runtime."));
            return S_OK;
        }
        auto *done = handler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller *>(
            L"{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}", [self](HRESULT result, ICoreWebView2Controller *view) {
                if (!self) return S_OK;
                if (SUCCEEDED(result) && view) self->attach(view);
                else self->fail(ui("Could not create the embedded map."));
                return S_OK;
            });
        const auto status = value->CreateCoreWebView2Controller(reinterpret_cast<HWND>(self->host->winId()), done);
        done->Release();
        if (FAILED(status)) self->fail(ui("Could not open WebView2."));
        return S_OK;
    });
    const auto browserData = QDir::toNativeSeparators(storage).toStdWString();
    const auto status = create(nullptr, browserData.c_str(), nullptr, environment);
    environment->Release();
    if (FAILED(status)) fail(ui("Could not start WebView2 Runtime."));
}

void MapView::attach(ICoreWebView2Controller *view)
{
    controller = view;
    controller->AddRef();
    ICoreWebView2 *web = nullptr;
    if (FAILED(controller->get_CoreWebView2(&web)) || !web) return fail(ui("The map could not access its renderer."));
    ICoreWebView2Settings *settings = nullptr;
    if (SUCCEEDED(web->get_Settings(&settings))) {
        settings->put_AreHostObjectsAllowed(FALSE);
        settings->put_IsWebMessageEnabled(TRUE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        IID settings4Id{};
        IIDFromString(L"{cb56846c-4168-4d53-b04f-03b6d6796ff2}", &settings4Id);
        ICoreWebView2Settings4 *autofill = nullptr;
        if (SUCCEEDED(settings->QueryInterface(settings4Id, reinterpret_cast<void **>(&autofill)))) {
            autofill->put_IsPasswordAutosaveEnabled(FALSE);
            autofill->put_IsGeneralAutofillEnabled(FALSE);
            autofill->Release();
        }
        settings->Release();
    }
    EventRegistrationToken registration;
    QPointer<MapView> self(this);
    auto *ready = handler<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *>(
        L"{57213f19-00e6-49fa-8e07-898ea01ecbd2}", [self](auto *, auto *args) {
        if (!self) return S_OK;
        LPWSTR source = nullptr;
        args->get_Source(&source);
        if (QUrl(takeWide(source)) != self->origin) return S_OK;
        LPWSTR value = nullptr;
        if (FAILED(args->TryGetWebMessageAsString(&value))) return S_OK;
        self->handleMapMessage(takeWide(value));
        return S_OK;
    });
    web->add_WebMessageReceived(ready, &registration);
    ready->Release();
    auto *navigation = handler<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *>(
        L"{9adbe429-f36d-432b-9ddc-f8881fbd76e3}", [self](auto *, auto *args) {
        LPWSTR uri = nullptr;
        args->get_Uri(&uri);
        const QUrl url(takeWide(uri));
        if (!self || url.scheme() != "http" || url.host() != "127.0.0.1" || url.port() != self->origin.port()) {
            args->put_Cancel(TRUE);
            if (self && (url.scheme() == "noticoin" || url.scheme() == QStringLiteral("ko" "ko")))
                QTimer::singleShot(0, self, [self, url] { if (self) self->invoice(url); });
            BOOL userInitiated = FALSE;
            args->get_IsUserInitiated(&userInitiated);
            if (self && userInitiated && url == QUrl("https://www.openstreetmap.org/copyright"))
                QTimer::singleShot(0, self, [url] { QDesktopServices::openUrl(url); });
        }
        return S_OK;
    });
    web->add_NavigationStarting(navigation, &registration);
    navigation->Release();
    auto *permissions = handler<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2 *, ICoreWebView2PermissionRequestedEventArgs *>(
        L"{15e1c6a3-c72a-4df3-91d7-d097fbec6bfd}", [](auto *, auto *args) {
            args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
            return S_OK;
        });
    web->add_PermissionRequested(permissions, &registration);
    permissions->Release();
    auto *windows = handler<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *>(
        L"{d4c185fe-c81c-4989-97af-2d3fa7ab5651}", [](auto *, auto *args) {
            args->put_Handled(TRUE);
            return S_OK;
        });
    web->add_NewWindowRequested(windows, &registration);
    windows->Release();
    IID id{};
    ICoreWebView2_4 *downloads = nullptr;
    IIDFromString(L"{20d02d59-6df2-42dc-bd06-f98a694b1302}", &id);
    if (SUCCEEDED(web->QueryInterface(id, reinterpret_cast<void **>(&downloads)))) {
        auto *deny = handler<ICoreWebView2DownloadStartingEventHandler, ICoreWebView2 *, ICoreWebView2DownloadStartingEventArgs *>(
            L"{efedc989-c396-41ca-83f7-07f845a55724}", [](auto *, auto *args) {
                args->put_Cancel(TRUE);
                return S_OK;
            });
        downloads->add_DownloadStarting(deny, &registration);
        deny->Release();
        downloads->Release();
    }
    ICoreWebView2_18 *external = nullptr;
    IIDFromString(L"{7a626017-28be-49b2-b865-3ba2b3522d90}", &id);
    if (SUCCEEDED(web->QueryInterface(id, reinterpret_cast<void **>(&external)))) {
        auto *block = handler<ICoreWebView2LaunchingExternalUriSchemeEventHandler, ICoreWebView2 *,
            ICoreWebView2LaunchingExternalUriSchemeEventArgs *>(
            L"{74f712e0-8165-43a9-a13f-0cce597e75df}", [self](auto *, auto *args) {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                const QUrl url(takeWide(uri));
                args->put_Cancel(TRUE);
                if (self && (url.scheme() == "noticoin" || url.scheme() == QStringLiteral("ko" "ko")))
                    QTimer::singleShot(0, self, [self, url] { if (self) self->invoice(url); });
                return S_OK;
            });
        external->add_LaunchingExternalUriScheme(block, &registration);
        block->Release();
        external->Release();
    }
    resizeRenderer();
    controller->put_IsVisible(TRUE);
    web->Navigate(origin.toString().toStdWString().c_str());
    web->Release();
    QTimer::singleShot(7500, this, [this] {
        if (!atlasReady) fail(ui("The interactive map is still loading. The offline world preview is available."));
    });
}

#endif

void MapView::handleMapMessage(const QString &message)
{
    if (message == "atlas-ready") {
        QTimer::singleShot(0, this, [this] {
            revealAtlas();
            syncTheme();
        });
    } else if (message == "note-vault-request") {
        auto secret = loadMapVaultSecret(profile);
        if (secret.isEmpty() && !mapVaultSecretExists(profile)) {
            secret = regtest ? qgetenv("NOTI_REGTEST_VAULT") : QByteArray{};
            if (secret.isEmpty()) {
                QByteArray random(32, Qt::Uninitialized);
                for (auto &octet : random) octet = char(QRandomGenerator::system()->generate() & 255);
                secret = random.toHex();
                random.fill('\0');
            }
            if (!saveMapVaultSecret(profile, secret)) {
                secret.fill('\0');
                secret.clear();
            }
        }
        postMapMessage(QString("note-vault-secret:") + QString::fromLatin1(secret.toBase64()));
        secret.fill('\0');
    } else if (message.startsWith("note-vault-save:")) {
        auto secret = QByteArray::fromBase64(message.mid(sizeof("note-vault-save:") - 1).toLatin1(), QByteArray::AbortOnBase64DecodingErrors);
        const auto saved = saveMapVaultSecret(profile, secret);
        secret.fill('\0');
        postMapMessage(saved ? "note-vault-saved" : "note-vault-save-failed");
    } else if (message.startsWith("map-wallet-request:") && message.size() < 6500) {
        const auto packet = QJsonDocument::fromJson(message.mid(sizeof("map-wallet-request:") - 1).toUtf8());
        if (packet.isObject()) QTimer::singleShot(0, this, [this, request = packet.object()] { walletRequest(request); });
    } else if (message.startsWith("copy-coordinates:")) {
        const auto coordinates = message.mid(sizeof("copy-coordinates:") - 1);
        static const QRegularExpression pattern(R"(^(-?\d{1,2}\.\d{6}), (-?\d{1,3}\.\d{6})$)");
        const auto match = pattern.match(coordinates);
        if (match.hasMatch() && qAbs(match.captured(1).toDouble()) <= 90 && qAbs(match.captured(2).toDouble()) <= 180) {
            QApplication::clipboard()->setText(coordinates);
            postMapMessage(QString("coordinates-copied:") + coordinates);
        }
    } else if (message.startsWith("copy-private-code:")) {
        const auto code = message.mid(sizeof("copy-private-code:") - 1);
        static const QRegularExpression pattern(R"(^(?:noti|\x6b\x6f\x6b\x6f)-(recipient|pin)-v1\.[A-Za-z0-9_-]+$)");
        if (code.size() <= 10000 && pattern.match(code).hasMatch()) {
            QApplication::clipboard()->setText(code);
            postMapMessage("private-code-copied");
        }
    }
}

void MapView::revealAtlas()
{
    if (atlasReady) return;
    atlasReady = true;
    notice->hide();
    preview->hide();
    host->show();
    resizeRenderer();
}

void MapView::resizeRenderer()
{
#ifdef Q_OS_WIN
    if (!controller) return;
    RECT client{};
    GetClientRect(reinterpret_cast<HWND>(host->winId()), &client);
    controller->put_Bounds(client);
#endif
}

void MapView::showEvent(QShowEvent *event)
{
    QWidget::showEvent(event);
    start();
    QTimer::singleShot(0, this, [this] {
        resizeRenderer();
#ifdef Q_OS_WIN
        if (controller) controller->put_IsVisible(TRUE);
#endif
        postMapMessage("map-active");
    });
}

void MapView::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    QTimer::singleShot(0, this, [this] { resizeRenderer(); });
}

void MapView::fail(const QString &message)
{
    notice->setText(message);
    notice->show();
    if (!atlasReady) preview->show();
}
}
