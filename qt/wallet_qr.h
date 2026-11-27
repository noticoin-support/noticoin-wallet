#pragma once
#include <QImage>

class QString;

namespace noticoin {
QImage addressQr(const QString &address, int side, qreal scale);
}
