#include "wallet_qr.h"
#include "vendor/qrcodegen/qrcodegen.hpp"
#include <QPainter>
#include <QString>

namespace noticoin {
QImage addressQr(const QString &address, int side, qreal scale)
{
    if (address.isEmpty()) return {};
    const auto bytes = address.toUtf8();
    const auto code = qrcodegen::QrCode::encodeText(bytes.constData(), qrcodegen::QrCode::Ecc::MEDIUM);
    const int pixels = qRound(side * scale);
    const int module = pixels / (code.getSize() + 8);
    if (!module) return {};
    QImage image(pixels, pixels, QImage::Format_RGB32);
    image.fill(Qt::white);
    const int start = (pixels - code.getSize() * module) / 2;
    QPainter painter(&image);
    painter.setPen(Qt::NoPen);
    painter.setBrush(QColor("#111827"));
    for (int y = 0; y < code.getSize(); ++y) {
        for (int x = 0; x < code.getSize(); ++x) {
            if (code.getModule(x, y)) painter.drawRect(start + x * module, start + y * module, module, module);
        }
    }
    painter.end();
    image.setDevicePixelRatio(scale);
    return image;
}
}
