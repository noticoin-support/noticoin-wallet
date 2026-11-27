#include "map_view.h"
#include "map_storage.h"
#include "wallet_ui.h"
#include <QDesktopServices>
#include <QFile>
#include <QTimer>
#include <QVBoxLayout>
#include <QWebChannel>
#include <QWebEngineDownloadRequest>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineView>
#include <openssl/evp.h>
#include <memory>

namespace noticoin {
namespace {
bool localMapUrl(const QUrl &url, const QUrl &origin)
{
    return url.scheme() == origin.scheme() && url.host() == origin.host() &&
        url.port() == origin.port() && url.userInfo().isEmpty();
}

class MapRequests final : public QWebEngineUrlRequestInterceptor {
public:
    MapRequests(QUrl origin, QObject *parent)
        : QWebEngineUrlRequestInterceptor(parent), origin(std::move(origin)) {}

    void interceptRequest(QWebEngineUrlRequestInfo &request) override
    {
        const auto url = request.requestUrl();
        request.block(!localMapUrl(url, origin) && url.scheme() != "blob" && url.scheme() != "data");
    }

private:
    const QUrl origin;
};

class MapPage final : public QWebEnginePage {
public:
    MapPage(QWebEngineProfile *profile, QUrl origin, std::function<void(QUrl)> invoice, QObject *parent)
        : QWebEnginePage(profile, parent), origin(std::move(origin)), invoice(std::move(invoice)) {}

protected:
    bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool mainFrame) override
    {
        if (localMapUrl(url, origin)) return true;
        if (!mainFrame) return false;
        if (url.scheme() == "noticoin" || url.scheme() == QStringLiteral("ko" "ko"))
            QTimer::singleShot(0, this, [this, url] { invoice(url); });
        if (type == NavigationTypeLinkClicked && url == QUrl("https://www.openstreetmap.org/copyright"))
            QTimer::singleShot(0, this, [url] { QDesktopServices::openUrl(url); });
        return false;
    }

private:
    const QUrl origin;
    const std::function<void(QUrl)> invoice;
};
}

class MapWebChannel final : public QObject {
    Q_OBJECT
public:
    MapWebChannel(QWebEnginePage *page, QUrl origin, QObject *parent)
        : QObject(parent), page(page), origin(std::move(origin)) {}

public slots:
    void postMessage(const QString &message)
    {
        if (message.size() <= 12000) emit received(message);
    }

    QVariantMap createMapSigningKey() const
    {
        if (page->url() != origin) return {};
        std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
            EVP_PKEY_Q_keygen(nullptr, nullptr, "ED25519"), EVP_PKEY_free);
        if (!key) return {};
        QByteArray publicKey(32, Qt::Uninitialized), privateKey(32, Qt::Uninitialized);
        size_t publicSize = publicKey.size(), privateSize = privateKey.size();
        const bool exported = EVP_PKEY_get_raw_public_key(key.get(), bytes(publicKey), &publicSize) == 1 &&
            EVP_PKEY_get_raw_private_key(key.get(), bytes(privateKey), &privateSize) == 1;
        if (!exported) {
            privateKey.fill('\0');
            return {};
        }
        const auto options = QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals;
        const auto secret = QString::fromLatin1(privateKey.toBase64(options));
        privateKey.fill('\0');
        return {
            {"publicKey", QString::fromLatin1(publicKey.toBase64())},
            {"privateKey", QVariantMap{{"kty", "OKP"}, {"crv", "Ed25519"},
                {"x", QString::fromLatin1(publicKey.toBase64(options))}, {"d", secret},
                {"key_ops", QStringList{"sign"}}, {"ext", true}}}
        };
    }

    QString signMapData(const QString &privateKey, const QString &payload) const
    {
        if (page->url() != origin || privateKey.size() != 43 || payload.size() > 1024 * 1024) return {};
        auto seed = QByteArray::fromBase64(privateKey.toLatin1(),
            QByteArray::Base64UrlEncoding | QByteArray::AbortOnBase64DecodingErrors);
        const auto message = QByteArray::fromBase64(payload.toLatin1(), QByteArray::AbortOnBase64DecodingErrors);
        if (seed.size() != 32 || message.isEmpty()) {
            seed.fill('\0');
            return {};
        }
        std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
            EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, bytes(seed), seed.size()), EVP_PKEY_free);
        seed.fill('\0');
        std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
        QByteArray signature(64, Qt::Uninitialized);
        size_t signatureSize = signature.size();
        if (!key || !context || EVP_DigestSignInit(context.get(), nullptr, nullptr, nullptr, key.get()) != 1 ||
            EVP_DigestSign(context.get(), bytes(signature), &signatureSize,
                reinterpret_cast<const unsigned char *>(message.constData()), message.size()) != 1) return {};
        return QString::fromLatin1(signature.toBase64());
    }

signals:
    void received(const QString &message);
    void delivered(const QString &message);

private:
    static unsigned char *bytes(QByteArray &value)
    {
        return reinterpret_cast<unsigned char *>(value.data());
    }

    QWebEnginePage *const page;
    const QUrl origin;
};

void MapView::createRenderer()
{
    const auto storage = prepareMapBrowserProfile(profile);
    if (storage.isEmpty()) return fail(ui("Could not open the wallet folder."));
    QFile library(":/qtwebchannel/qwebchannel.js");
    if (!library.open(QIODevice::ReadOnly)) return fail(ui("Could not create the embedded map."));
    auto *view = new QWebEngineView(host);
    auto *webProfile = new QWebEngineProfile("NoticoinAtlas", host);
    webProfile->setPersistentStoragePath(storage + "/storage");
    webProfile->setCachePath(storage + "/cache");
    webProfile->setPersistentCookiesPolicy(QWebEngineProfile::NoPersistentCookies);
    webProfile->setUrlRequestInterceptor(new MapRequests(origin, webProfile));
    connect(webProfile, &QWebEngineProfile::downloadRequested, this,
        [](QWebEngineDownloadRequest *download) { download->cancel(); });
    auto *page = new MapPage(webProfile, origin, invoice, view);
    auto *settings = page->settings();
    settings->setAttribute(QWebEngineSettings::JavascriptCanOpenWindows, false);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, false);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, false);
    settings->setAttribute(QWebEngineSettings::PdfViewerEnabled, false);
    settings->setAttribute(QWebEngineSettings::PlaybackRequiresUserGesture, true);
    // The page handles wallet invoices internally and rejects navigation outside the map.
    settings->setUnknownUrlSchemePolicy(QWebEngineSettings::AllowAllUnknownUrlSchemes);
    connect(page, &QWebEnginePage::featurePermissionRequested, page,
        [page](const QUrl &url, QWebEnginePage::Feature feature) {
            page->setFeaturePermission(url, feature, QWebEnginePage::PermissionDeniedByUser);
        });
    auto *bridge = new QWebChannel(page);
    channel = new MapWebChannel(page, origin, bridge);
    connect(channel, &MapWebChannel::received, this, [this, page](const QString &message) {
        if (page->url() == origin) handleMapMessage(message);
    });
    bridge->registerObject("walletBridge", channel);
    page->setWebChannel(bridge);

    QWebEngineScript adapter;
    adapter.setName("Noticoin wallet bridge");
    adapter.setInjectionPoint(QWebEngineScript::DocumentCreation);
    adapter.setWorldId(QWebEngineScript::MainWorld);
    adapter.setRunsOnSubFrames(false);
    adapter.setSourceCode(QString::fromUtf8(library.readAll()) + QStringLiteral(R"JS(
;(() => {
    if (!AbortSignal.timeout) {
        AbortSignal.timeout = milliseconds => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), milliseconds);
            return controller.signal;
        };
    }
    const events = new EventTarget();
    const pending = [];
    let bridge;
    const channelReady = new Promise(resolve => {
        new QWebChannel(qt.webChannelTransport, channel => {
            bridge = channel.objects.walletBridge;
            bridge.delivered.connect(data => events.dispatchEvent(new MessageEvent('message', {data})));
            for (const value of pending.splice(0)) bridge.postMessage(value);
            resolve(bridge);
        });
    });
    window.chrome = window.chrome || {};
    window.chrome.webview = {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        postMessage(value) {
            if (typeof value !== 'string' || value.length > 12000) return;
            if (bridge) bridge.postMessage(value);
            else if (pending.length < 32) pending.push(value);
        }
    };
    window.NoticoinMapSigning = {
        createKey: async () => {
            const connection = await channelReady;
            return new Promise(resolve => connection.createMapSigningKey(resolve));
        },
        sign: async (privateKey, payload) => {
            const connection = await channelReady;
            return new Promise(resolve => connection.signMapData(privateKey, payload, resolve));
        }
    };
})();
)JS"));
    page->scripts().insert(adapter);
    view->setPage(page);
    view->setContextMenuPolicy(Qt::NoContextMenu);
    auto *layout = new QVBoxLayout(host);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(view);
    connect(page, &QWebEnginePage::loadFinished, this, [this](bool ok) {
        if (!ok && !atlasReady) fail(ui("Could not create the embedded map."));
    });
    view->load(origin);
    QTimer::singleShot(15000, this, [this] {
        if (!atlasReady) fail(ui("The interactive map is still loading. The offline world preview is available."));
    });
}

void MapView::postMapMessage(const QString &message)
{
    if (channel) emit channel->delivered(message);
}
}

#include "map_webengine.moc"
