#include "wallet_window.h"
#include "wallet_qr.h"
#include "wallet_service.h"
#include "wallet_ui.h"
#include "map_view.h"

#include <QApplication>
#include <QClipboard>
#include <QCloseEvent>
#include <QComboBox>
#include <QDateTime>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QEvent>
#include <QFrame>
#include <QFontMetrics>
#include <QGridLayout>
#include <QHeaderView>
#include <QInputDialog>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QListView>
#include <QMenu>
#include <QPainter>
#include <QPainterPath>
#include <QPlainTextEdit>
#include <QPointer>
#include <QPropertyAnimation>
#include <QPushButton>
#include <QRegularExpression>
#include <QScrollArea>
#include <QScreen>
#include <QSettings>
#include <QShortcut>
#include <QSignalBlocker>
#include <QStackedWidget>
#include <QStyle>
#include <QStyledItemDelegate>
#include <QStyleOptionButton>
#include <QStyleOptionComboBox>
#include <QStylePainter>
#include <QTableWidget>
#include <QTextOption>
#include <QTimer>
#include <QUrlQuery>
#include <QVariantAnimation>
#include <QVBoxLayout>
#include <QtMath>
#include <algorithm>
#include <utility>
#ifdef Q_OS_WIN
#include <windows.h>
#include <dwmapi.h>
#endif

namespace noticoin {
namespace {
bool clientAnimationsEnabled()
{
#ifdef Q_OS_WIN
    BOOL enabled = TRUE;
    SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0);
    return enabled;
#else
    return QApplication::isEffectEnabled(Qt::UI_General);
#endif
}

const char *theme = R"QSS(
QWidget { color: #eaf0ff; }
QMainWindow, QWidget#canvas, QWidget#workspace, QWidget#body, QWidget#scrollAreaBody { background: #090d19; }
QDialog, QMessageBox { background: #111829; }
QWidget#accessSurface, QScrollArea#accessScroll { background: #0b101e; }
QWidget#rail { background: #0d1322; border-right: 1px solid #202b41; }
QWidget#header { background: #0d1322; border-bottom: 1px solid #202b41; }
QFrame#card, QTableWidget { background: #11192a; border: 1px solid #26334d; }
QFrame#inset { background: #0e1526; border: 1px solid #293654; }
QFrame#balanceTable { background: #0d1526; border: 1px solid #3c4969; }
QFrame#sectionLine { background: #27344e; max-height: 1px; min-height: 1px; border: 0; }
QFrame#codeWell { background: #0f1729; border: 1px solid #2d3953; }
QLabel#title { font-size: 24px; font-weight: 650; }
QLabel#heading { font-size: 22px; font-weight: 650; }
QLabel#balance { color: #f4f5ff; font: 650 26px "Consolas"; }
QLabel#balanceValue { color: #e7edff; font: 600 16px "Consolas"; }
QLabel#availableValue { color: #97e8ca; font: 600 16px "Consolas"; }
QLabel#muted { color: #a1b0ca; }
QLabel#field { color: #b8c4dc; font-weight: 650; font-size: 13px; }
QLabel#eyebrow { color: #aebcff; font-weight: 650; font-size: 13px; }
QLabel#currency, QLabel#walletBadge {
    color: #ccd3ff; background: #202b50; border: 1px solid #35456d;
    padding: 5px 9px; font-size: 13px; font-weight: 650;
}
QLabel#cardNumber { color: #eff2ff; font-size: 26px; font-weight: 650; }
QLabel#cardValue { color: #e9eeff; font-weight: 650; }
QLabel#accessTitle { color: #f1f3ff; font-size: 34px; font-weight: 700; }
QLabel#accessDescription { color: #a8b6d0; font-size: 15px; }
QLabel#accessBrand { color: #ffffff; font-size: 40px; font-weight: 750; }
QLabel#accessBrandCaption { color: #bbc8ee; font-size: 16px; }
QLabel#accessMapCredits { color: #c3cff0; font-size: 12px; }
QLineEdit#accessValue, QComboBox#accessValue { min-height: 26px; }
QPushButton#accessPrimary { padding: 9px 18px; min-width: 112px; min-height: 24px; color: #111834; background: #aebaff; border-color: #aebaff; }
QPushButton#accessPrimary:hover { background: #c4ccff; border-color: #c4ccff; }
QPushButton#accessPrimary:pressed { background: #97a9f7; border-color: #97a9f7; }
QPushButton#accessPrimary:focus { border-color: #edf0ff; }
QPushButton#accessPrimary:disabled { color: #8594b1; background: #172035; border-color: #29364f; }
QPushButton#accessLink { color: #b8c5e2; background: transparent; border-color: transparent; padding: 5px 8px; font-size: 14px; }
QPushButton#accessLink:hover { color: #f1f3ff; background: #18243a; }
QPushButton#accessLink:focus { border-color: #8397ee; }
QPushButton#accessLink:disabled { color: #687694; background: transparent; border-color: transparent; }
QPushButton[accessIcon="true"] { padding: 0; min-height: 0; background: transparent; border-color: #303e5a; }
QPushButton[accessIcon="true"]:hover { background: #1b2944; border-color: #566a91; }
QPushButton[accessIcon="true"]:pressed { background: #263755; }
QPushButton[accessIcon="true"]:focus { border-color: #8397ee; }
QLabel#incomingAmount { color: #94e7c1; font-weight: 650; }
QLabel#outgoingAmount { color: #ffadb4; font-weight: 650; }
QLabel#arrowIn, QLabel#arrowOut { background: #17392f; color: #a3f0ce; font-size: 20px; font-weight: 700; }
QLabel#arrowOut { background: #422538; color: #ffadb4; }
QLabel#receiveQr { background: #182238; color: #b6c1dc; border: 1px solid #35415a; font-size: 13px; }
QLabel#brand { color: #ffffff; font-weight: 750; font-size: 25px; }
QLabel#railMuted { color: #9eadd0; font-size: 13px; }
QLabel#onAtlas { color: #f2f4ff; font-weight: 650; font-size: 22px; }
QLabel#atlasHint { color: #c0cbea; }
QLabel#error { color: #ffa9ba; font-size: 13px; }
QLabel#notification { background: #18243c; border: 1px solid #455880; padding: 13px 17px; }
QPushButton {
    background: #19233a; border: 1px solid #35435e;
    padding: 9px 14px; min-height: 24px; color: #e3eaff; font-weight: 600;
}
QPushButton:hover { background: #223051; border-color: #506289; }
QPushButton:pressed { background: #263755; }
QPushButton:focus { border-color: #8397ee; }
QPushButton:disabled, QPushButton#primary:disabled { color: #8594b1; background: #172035; border-color: #29364f; }
QPushButton#primary { color: #111834; background: #aebaff; border-color: #aebaff; font-weight: 650; }
QPushButton#primary:hover { background: #c4ccff; border-color: #c4ccff; }
QPushButton#primary:pressed { background: #97a9f7; border-color: #97a9f7; }
QPushButton#primary:focus { border-color: #edf0ff; }
QPushButton#nav { text-align: left; border: none; background: transparent; color: #afbedc; padding-left: 14px; }
QPushButton#nav:hover { background: #19243b; color: #edf2ff; }
QPushButton#nav:checked { background: #253455; color: #f1f3ff; }
QPushButton#nav:disabled { background: transparent; color: #687694; }
QPushButton#chip { background: #18233a; color: #d5ddfa; border-color: #334260; padding-right: 32px; }
QPushButton#chip:hover { background: #223051; border-color: #506289; }
QPushButton#chip:focus { border-color: #8397ee; }
QPushButton#chip::menu-indicator { subcontrol-origin: padding; subcontrol-position: center right; right: 11px; }
QPushButton#maximum:checked { color: #dce4ff; background: #293960; border-color: #7891ed; }
QLineEdit, QPlainTextEdit, QComboBox {
    color: #e9eeff; background: #0c1425; border: 1px solid #394662;
    padding: 8px 12px; selection-background-color: #374c84; selection-color: #f6f7ff;
    placeholder-text-color: #8c9ab5;
}
QLineEdit { min-height: 25px; }
QLineEdit:disabled, QPlainTextEdit:disabled, QComboBox:disabled { color: #8594b1; background: #101827; border-color: #26334b; }
QPlainTextEdit#addressField { font: 15px "Consolas"; }
QLineEdit#amountValue { background: #101a2d; padding: 6px 10px; min-height: 43px; font-size: 24px; font-weight: 600; }
QComboBox { padding-right: 34px; }
QComboBox::drop-down {
    subcontrol-origin: padding; subcontrol-position: top right; width: 34px;
    border: none; background: transparent;
}
QComboBox::down-arrow { image: none; width: 0; height: 0; }
QComboBox QListView#comboOptions { background: #131d32; border: 1px solid #41506e; padding: 4px; outline: none; }
QScrollArea { border: none; background: #090d19; }
QTableWidget { gridline-color: #293750; selection-background-color: #24365c; selection-color: #f2f4ff; alternate-background-color: #131e33; }
QHeaderView::section { background: #18243a; color: #c4d0ec; border: 0; padding: 12px; font-weight: 600; }
QTableWidget#historyTable::item { padding-left: 12px; }
QMenu { background: #11192a; border: 1px solid #394662; padding: 4px; }
QMenu::item { padding: 7px 24px 7px 12px; }
QMenu::item:selected { background: #253455; }
QMenu::separator { height: 1px; margin: 4px 6px; background: #394662; }
QScrollBar:vertical { background: transparent; width: 9px; }
QScrollBar::handle:vertical { background: #354563; min-height: 22px; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
)QSS";

const char *lightTheme = R"QSS(
QWidget { color: #1d2a45; }
QMainWindow, QWidget#canvas, QWidget#workspace, QWidget#body, QWidget#scrollAreaBody, QScrollArea { background: #f0f3fa; }
QDialog, QMessageBox, QWidget#accessSurface, QScrollArea#accessScroll { background: #f8faff; }
QWidget#rail, QWidget#header { background: #fbfcff; border-color: #d9e1ef; }
QFrame#card, QTableWidget { background: #fff; border-color: #d7dfef; }
QFrame#inset, QFrame#codeWell, QFrame#balanceTable { background: #f6f8fe; border-color: #cbd6eb; }
QFrame#sectionLine { background: #d9e0ee; }
QLabel#balance, QLabel#balanceValue, QLabel#accessTitle, QLabel#cardNumber, QLabel#cardValue, QLabel#brand { color: #182746; }
QLabel#availableValue, QLabel#incomingAmount { color: #16674e; }
QLabel#outgoingAmount { color: #a12544; }
QLabel#muted, QLabel#field, QLabel#accessDescription, QLabel#railMuted { color: #4b5a76; }
QLabel#eyebrow, QLabel#currency, QLabel#walletBadge { color: #354b9a; }
QLabel#currency, QLabel#walletBadge { background: #e7ecfc; border-color: #cbd5f0; }
QLabel#arrowIn { background: #dcefe7; color: #16674e; }
QLabel#arrowOut { background: #f9e4e8; color: #a12544; }
QLabel#receiveQr { background: #f7f9ff; color: #526381; border-color: #d4dff0; }
QLabel#onAtlas, QLabel#accessBrand { color: #243b6b; }
QLabel#atlasHint, QLabel#accessBrandCaption { color: #465a81; }
QLabel#accessMapCredits { color: #405477; }
QLabel#error { color: #a32248; }
QLabel#notification { color: #1d2a45; background: #fbfcff; border-color: #a9b9df; }
QPushButton, QPushButton#chip { background: #f3f6fd; color: #253659; border-color: #ccd7eb; }
QPushButton:hover { background: #e7edfc; border-color: #9dadcf; }
QPushButton#chip:hover { background: #e7edfc; border-color: #9dadcf; }
QPushButton#chip:focus { border-color: #526bc1; }
QPushButton:pressed, QPushButton#maximum:checked { background: #dbe5fd; color: #29449a; border-color: #8299d6; }
QPushButton:focus { border-color: #526bc1; }
QPushButton#primary, QPushButton#accessPrimary { background: #405aba; color: #fff; border-color: #405aba; }
QPushButton#primary:hover, QPushButton#accessPrimary:hover { background: #344da9; border-color: #344da9; }
QPushButton#accessPrimary:pressed { background: #2a4091; border-color: #2a4091; }
QPushButton#primary:focus, QPushButton#accessPrimary:focus { border-color: #233b8f; }
QPushButton:disabled, QPushButton#primary:disabled, QPushButton#accessPrimary:disabled { background: #edf1f8; color: #687791; border-color: #d8e1ee; }
QPushButton#accessLink { color: #425780; background: transparent; border-color: transparent; }
QPushButton#accessLink:hover { color: #233b75; background: #eaf0fc; }
QPushButton#accessLink:focus { border-color: #526bc1; }
QPushButton#accessLink:disabled { color: #8190aa; background: transparent; border-color: transparent; }
QPushButton[accessIcon="true"] { background: transparent; border-color: #ced9ec; }
QPushButton[accessIcon="true"]:hover { background: #e7edfc; border-color: #9dadcf; }
QPushButton[accessIcon="true"]:pressed { background: #dbe5fd; }
QPushButton[accessIcon="true"]:focus { border-color: #526bc1; }
QPushButton#nav { background: transparent; color: #445779; border: none; }
QPushButton#nav:hover { background: #eef3ff; color: #233b75; }
QPushButton#nav:checked { background: #e1e9fe; color: #264083; }
QPushButton#nav:disabled { background: transparent; color: #8190aa; }
QLineEdit, QPlainTextEdit, QComboBox {
    color: #192846; background: #fcfdff; border-color: #afbdd9; selection-background-color: #ccdaf9;
    selection-color: #1b326c; placeholder-text-color: #61708e;
}
QLineEdit#amountValue { background: #fff; }
QLineEdit:disabled, QPlainTextEdit:disabled, QComboBox:disabled { color: #687791; background: #edf1f8; border-color: #d8e1ee; }
QComboBox QListView#comboOptions { background: #fff; border-color: #aebcdc; }
QTableWidget { gridline-color: #d9e0ee; selection-background-color: #e0e9fd; selection-color: #233c82; alternate-background-color: #f5f8fd; }
QHeaderView::section { background: #eaf0fc; color: #33466e; }
QMenu { background: #fbfcff; border-color: #ccd7eb; }
QMenu::item:selected { background: #e1e9fe; }
QMenu::separator { background: #d9e1ef; }
QScrollBar::handle:vertical { background: #aab9d5; }
)QSS";

bool lightAppearance()
{
    return QApplication::palette().color(QPalette::Window).lightness() > 128;
}

QLabel *label(QString text, const char *style = nullptr, bool wrap = false)
{
    auto *widget = new QLabel(std::move(text));
    widget->setTextFormat(Qt::PlainText);
    if (style) widget->setObjectName(style);
    widget->setWordWrap(wrap);
    return widget;
}

QPushButton *button(QString text, bool primary = false)
{
    auto *widget = new QPushButton(std::move(text));
    widget->setCursor(Qt::PointingHandCursor);
    if (primary) widget->setObjectName("primary");
    return widget;
}

class NavigationButton final : public QPushButton {
public:
    explicit NavigationButton(const QString &text) : QPushButton(text)
    {
        setObjectName("nav");
        setCursor(Qt::PointingHandCursor);
        setFocusPolicy(Qt::StrongFocus);
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QStyleOptionButton option;
        initStyleOption(&option);
        option.state &= ~QStyle::State_HasFocus;
        QStylePainter painter(this);
        painter.drawControl(QStyle::CE_PushButton, option);
        if (hasFocus() && keyboardFocus) {
            painter.setPen(Qt::NoPen);
            painter.setBrush(QApplication::palette().color(QPalette::Link));
            painter.drawRoundedRect(QRectF(4, (height() - 16) / 2.0, 2, 16), 1, 1);
        }
    }

    void focusInEvent(QFocusEvent *event) override
    {
        keyboardFocus = event->reason() == Qt::TabFocusReason || event->reason() == Qt::BacktabFocusReason;
        QPushButton::focusInEvent(event);
    }

    void mousePressEvent(QMouseEvent *event) override
    {
        keyboardFocus = false;
        QPushButton::mousePressEvent(event);
    }

private:
    bool keyboardFocus = false;
};

class FieldAccent final : public QWidget {
public:
    explicit FieldAccent(QWidget *input) : QWidget(input)
    {
        setAttribute(Qt::WA_TransparentForMouseEvents);
        setAttribute(Qt::WA_NoSystemBackground);
        setGeometry(input->rect());
        fade.setDuration(160);
        fade.setEasingCurve(QEasingCurve::OutCubic);
        connect(&fade, &QVariantAnimation::valueChanged, this, [this](const QVariant &value) {
            opacity = value.toReal();
            update();
        });
        input->installEventFilter(this);
        raise();
        show();
    }

protected:
    bool eventFilter(QObject *watched, QEvent *event) override
    {
        auto *input = parentWidget();
        if (watched != input) return false;
        switch (event->type()) {
        case QEvent::FocusIn: focused = true; break;
        case QEvent::FocusOut: focused = false; break;
        case QEvent::Enter: hovered = true; break;
        case QEvent::Leave: hovered = false; break;
        case QEvent::EnabledChange: break;
        case QEvent::Resize:
        case QEvent::Show:
            setGeometry(input->rect());
            raise();
            return false;
        default: return false;
        }
        const qreal target = !input->isEnabled() ? 0.0 : focused ? 1.0 : hovered ? .33 : 0.0;
        if (target != fade.endValue().toReal()) {
            fade.stop();
            fade.setStartValue(opacity);
            fade.setEndValue(target);
            fade.start();
        }
        return false;
    }

    void paintEvent(QPaintEvent *) override
    {
        if (opacity <= 0) return;
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        QColor accent = QApplication::palette().color(QPalette::Link);
        painter.setBrush(Qt::NoBrush);
        accent.setAlphaF(float(opacity));
        painter.setPen(QPen(accent, 1.65));
        painter.drawRect(QRectF(rect()).adjusted(.8, .8, -.8, -.8));
    }

private:
    QVariantAnimation fade;
    qreal opacity = 0;
    bool focused = false;
    bool hovered = false;
};

class ComboRow final : public QStyledItemDelegate {
public:
    explicit ComboRow(QComboBox *owner) : QStyledItemDelegate(owner), combo(owner) {}

    QSize sizeHint(const QStyleOptionViewItem &option, const QModelIndex &index) const override
    {
        return QStyledItemDelegate::sizeHint(option, index).expandedTo(QSize(0, 36)) + QSize(35, 0);
    }

    void paint(QPainter *painter, const QStyleOptionViewItem &option, const QModelIndex &index) const override
    {
        auto row = option;
        initStyleOption(&row, index);
        const auto area = row.rect.adjusted(1, 1, -1, -1);
        const auto colors = QApplication::palette();
        const auto accent = colors.color(QPalette::Link);
        const bool selected = row.state.testFlag(QStyle::State_Selected);
        const bool current = index.row() == combo->currentIndex();
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        if (selected || current || row.state.testFlag(QStyle::State_MouseOver)) {
            const auto surface = selected ? colors.color(QPalette::Highlight)
                                          : colors.color(QPalette::AlternateBase);
            painter->setPen(Qt::NoPen);
            painter->setBrush(surface);
            painter->drawRect(area);
        }
        const auto textArea = area.adjusted(10, 0, -34, 0);
        const auto group = row.state.testFlag(QStyle::State_Enabled) ? QPalette::Active : QPalette::Disabled;
        painter->setPen(colors.color(group, selected ? QPalette::HighlightedText : QPalette::Text));
        painter->setFont(row.font);
        painter->drawText(textArea, Qt::AlignVCenter | Qt::AlignLeft | Qt::TextSingleLine,
                          row.fontMetrics.elidedText(row.text, Qt::ElideRight, textArea.width()));
        if (current) {
            const QPointF center(area.right() - 15, area.center().y());
            painter->setPen(QPen(accent, 1.7, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
            painter->drawPolyline(QPolygonF{center + QPointF(-4, 0), center + QPointF(-1, 3), center + QPointF(5, -3)});
        }
        painter->restore();
    }

private:
    const QComboBox *combo;
};

class AnimatedCombo final : public QComboBox {
public:
    explicit AnimatedCombo(QWidget *parent = nullptr) : QComboBox(parent)
    {
        auto *options = new QListView;
        options->setObjectName("comboOptions");
        options->setMouseTracking(true);
        options->setUniformItemSizes(true);
        options->setVerticalScrollMode(QAbstractItemView::ScrollPerPixel);
        options->setCursor(Qt::PointingHandCursor);
        setView(options);
        setItemDelegate(new ComboRow(this));
        setMaxVisibleItems(7);
        setCursor(Qt::PointingHandCursor);
        motion.setDuration(155);
        motion.setStartValue(0.0);
        motion.setEndValue(1.0);
        motion.setEasingCurve(QEasingCurve::OutCubic);
        connect(&motion, &QVariantAnimation::valueChanged, this, [this](const QVariant &value) {
            if (!popup || !popup->isVisible()) return;
            const auto progress = value.toReal();
            popup->move(restingPosition - QPoint(0, qRound(5 * (1 - progress))));
            popup->setWindowOpacity(.55 + .45 * progress);
            angle = 180 * progress;
            update();
        });
    }

    void showPopup() override
    {
        if (view()->isVisible()) return;
        QComboBox::showPopup();
        auto *panel = view()->window();
        if (panel == window() || !panel->isVisible()) return;
        popup = panel;
        restingPosition = panel->pos();
        if (clientAnimationsEnabled()) {
            panel->move(restingPosition - QPoint(0, 5));
            panel->setWindowOpacity(.55);
            angle = 0;
            motion.start();
        } else {
            angle = 180;
        }
        update();
    }

    void hidePopup() override
    {
        motion.stop();
        QComboBox::hidePopup();
        if (popup) popup->setWindowOpacity(1);
        angle = 0;
        update();
    }

protected:
    void paintEvent(QPaintEvent *event) override
    {
        QComboBox::paintEvent(event);
        QStyleOptionComboBox option;
        initStyleOption(&option);
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.setPen(QPen(QApplication::palette().color(QPalette::Link), 1.65,
                            Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        painter.translate(style()->subControlRect(QStyle::CC_ComboBox, &option, QStyle::SC_ComboBoxArrow, this).center());
        painter.rotate(angle);
        painter.drawPolyline(QPolygonF{QPointF(-4, -2), QPointF(0, 2), QPointF(4, -2)});
    }

private:
    QPointer<QWidget> popup;
    QVariantAnimation motion;
    QPoint restingPosition;
    qreal angle = 0;
};

class BalanceAmount final : public QLabel {
public:
    explicit BalanceAmount(const char *name) : QLabel("—")
    {
        setObjectName(name);
        setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        const auto area = contentsRect();
        auto fitted = font();
        if (QFontMetrics(fitted).horizontalAdvance(text()) > area.width()) {
            const qreal ratio = qreal(area.width()) / QFontMetrics(fitted).horizontalAdvance(text());
            if (fitted.pixelSize() > 0) fitted.setPixelSize(qMax(1, qFloor(fitted.pixelSize() * ratio)));
            else fitted.setPointSizeF(qMax(1.0, fitted.pointSizeF() * ratio));
        }
        QPainter painter(this);
        painter.setFont(fitted);
        painter.setPen(palette().color(QPalette::WindowText));
        painter.drawText(area, alignment() | Qt::TextSingleLine, text());
    }
};

QVBoxLayout *column(QWidget *widget, int margin = 0, int gap = 12)
{
    auto *layout = new QVBoxLayout(widget);
    layout->setContentsMargins(margin, margin, margin, margin);
    layout->setSpacing(gap);
    return layout;
}

QFrame *card()
{
    auto *frame = new QFrame;
    frame->setObjectName("card");
    return frame;
}

QWidget *scrollPage(QWidget *body)
{
    auto *scroll = new QScrollArea;
    auto *container = new QWidget;
    container->setObjectName("scrollAreaBody");
    auto *aligned = new QHBoxLayout(container);
    aligned->setContentsMargins(0, 0, 0, 0);
    aligned->addWidget(body, 1, Qt::AlignTop);
    body->setMaximumWidth(1210);
    scroll->setWidgetResizable(true);
    scroll->setWidget(container);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    return scroll;
}

void buttons(QVBoxLayout *layout, const QList<QPushButton *> &members)
{
    auto *row = new QHBoxLayout;
    row->setSpacing(9);
    for (auto *member : members) row->addWidget(member);
    row->addStretch();
    layout->addLayout(row);
}

QPlainTextEdit *textBox(const QString &name, bool readOnly = false)
{
    auto *edit = new QPlainTextEdit;
    edit->setAccessibleName(name);
    edit->setReadOnly(readOnly);
    edit->setFixedHeight(88);
    edit->setTabChangesFocus(true);
    new FieldAccent(edit);
    return edit;
}

QPlainTextEdit *addressBox(const QString &name, bool readOnly = false)
{
    auto *edit = textBox(name, readOnly);
    edit->setObjectName("addressField");
    edit->setWordWrapMode(QTextOption::WrapAnywhere);
    edit->setFixedHeight(86);
    return edit;
}

QFrame *sectionLine()
{
    auto *line = new QFrame;
    line->setObjectName("sectionLine");
    return line;
}

void rowHeading(QVBoxLayout *layout, QLabel *title, QWidget *trailing)
{
    auto *row = new QHBoxLayout;
    row->setSpacing(8);
    row->addWidget(title, 1);
    row->addWidget(trailing, 0, Qt::AlignVCenter);
    layout->addLayout(row);
}

void field(QVBoxLayout *layout, const QString &name, QWidget *input)
{
    auto *caption = label(name, "field", true);
    caption->setBuddy(input);
    input->setAccessibleName(name);
    if (!qobject_cast<QPlainTextEdit *>(input)) new FieldAccent(input);
    layout->addWidget(caption);
    layout->addWidget(input);
}

void dialogButtons(QVBoxLayout *layout, const QList<QPushButton *> &members)
{
    auto *row = new QHBoxLayout;
    row->setSpacing(8);
    row->addStretch();
    for (auto *member : members) row->addWidget(member);
    layout->addSpacing(9);
    layout->addLayout(row);
}

constexpr std::array<const char *, 4> feePriorities{"Low", "Normal", "Fast", "Very fast"};

QTableWidget *readOnlyTable(const QStringList &headers)
{
    auto *table = new QTableWidget(0, headers.size());
    table->setHorizontalHeaderLabels(headers);
    table->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    table->verticalHeader()->hide();
    table->verticalHeader()->setDefaultSectionSize(34);
    table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    table->setSelectionBehavior(QAbstractItemView::SelectRows);
    table->setSelectionMode(QAbstractItemView::SingleSelection);
    table->setAlternatingRowColors(true);
    table->setShowGrid(false);
    return table;
}

void accessActions(QVBoxLayout *layout, QPushButton *primary, QPushButton *back = nullptr, bool centered = false)
{
    primary->setObjectName("accessPrimary");
    if (back) back->setObjectName("accessLink");
    if (centered) {
        layout->addWidget(primary, 0, Qt::AlignHCenter);
        if (back) layout->addWidget(back, 0, Qt::AlignHCenter);
        return;
    }
    auto *row = new QHBoxLayout;
    row->setSpacing(9);
    if (back) row->addWidget(back);
    row->addStretch();
    row->addWidget(primary);
    layout->addLayout(row);
}

void accessAlternatives(QVBoxLayout *layout, const QList<QPushButton *> &choices)
{
    layout->addWidget(sectionLine());
    auto *row = new QHBoxLayout;
    row->setSpacing(8);
    row->addStretch();
    for (auto *choice : choices) {
        choice->setObjectName("accessLink");
        row->addWidget(choice);
    }
    row->addStretch();
    layout->addLayout(row);
}

void fillLanguages(QComboBox *box, bool seed)
{
    box->addItem("English", seed ? "English" : "en");
    box->addItem("Français", seed ? "French" : "fr");
    box->addItem("Deutsch", seed ? "German" : "de");
    box->addItem("简体中文", seed ? "Chinese (simplified)" : "zh");
    box->addItem("日本語", seed ? "Japanese" : "ja");
}

QIcon navIcon(int item)
{
    QPixmap graphic(40, 40);
    graphic.fill(Qt::transparent);
    QPainter pen(&graphic);
    pen.setRenderHint(QPainter::Antialiasing);
    pen.scale(2, 2);
    pen.setPen(QPen(lightAppearance() ? QColor("#405a86") : QColor("#acbfe6"),1.35,Qt::SolidLine,Qt::RoundCap,Qt::RoundJoin));
    if (item == 0) {
        pen.drawRoundedRect(QRectF(2.5,3,6,5.3),1,1);
        pen.drawRoundedRect(QRectF(11,3,6.5,5.3),1,1);
        pen.drawRoundedRect(QRectF(2.5,11,6,6),1,1);
        pen.drawRoundedRect(QRectF(11,11,6.5,6),1,1);
    } else if (item == 1 || item == 2) {
        const bool send = item == 1;
        pen.drawLine(QPointF(10,send ? 16 : 4),QPointF(10,send ? 4 : 16));
        pen.drawPolyline(QPolygonF{QPointF(5.5,send ? 8.5 : 11.5),QPointF(10,send ? 4 : 16),QPointF(14.5,send ? 8.5 : 11.5)});
    } else if (item == 3) {
        pen.drawEllipse(QRectF(2.6,2.6,14.8,14.8));
        pen.drawPolyline(QPolygonF{QPointF(10,5.5),QPointF(10,10),QPointF(13.2,12)});
    } else if (item == 4) {
        pen.drawEllipse(QRectF(2.6,2.6,14.8,14.8));
        pen.drawEllipse(QRectF(6.5,2.6,7,14.8));
        pen.drawLine(QPointF(3.2,10),QPointF(16.8,10));
    } else if (item == 5) {
        pen.drawRoundedRect(QRectF(2.8,4.6,14.4,11),2,2);
        pen.drawLine(QPointF(3,8.2),QPointF(17,8.2));
        pen.drawPoint(QPointF(13.8,12));
    } else {
        pen.drawRoundedRect(QRectF(3.6,3.6,12.8,12.8),3,3);
        pen.drawRoundedRect(QRectF(7.1,7.1,5.8,5.8),1.2,1.2);
    }
    pen.end();
    graphic.setDevicePixelRatio(2);
    return QIcon(graphic);
}

enum class AccessSymbol { Exit, Sun, Moon };

QIcon accessIcon(AccessSymbol symbol)
{
    QPixmap graphic(40, 40);
    graphic.fill(Qt::transparent);
    QPainter painter(&graphic);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.scale(2, 2);
    const auto color = lightAppearance() ? QColor("#405a86") : QColor("#acbfe6");
    painter.setPen(QPen(color, 1.4, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    if (symbol == AccessSymbol::Exit) {
        painter.drawPolyline(QPolygonF{QPointF(10.5, 3.5), QPointF(4, 3.5), QPointF(4, 16.5), QPointF(10.5, 16.5)});
        painter.drawLine(QPointF(8, 10), QPointF(16.5, 10));
        painter.drawPolyline(QPolygonF{QPointF(13, 6.5), QPointF(16.5, 10), QPointF(13, 13.5)});
    } else if (symbol == AccessSymbol::Sun) {
        painter.drawEllipse(QPointF(10, 10), 3.6, 3.6);
        for (int ray = 0; ray < 8; ++ray) {
            painter.drawLine(QPointF(10, 3), QPointF(10, 4.5));
            painter.translate(10, 10);
            painter.rotate(45);
            painter.translate(-10, -10);
        }
    } else {
        QPainterPath crescent;
        crescent.moveTo(10.3, 3.2);
        crescent.cubicTo(4.3, 3.4, 2.3, 10.1, 5.3, 14.0);
        crescent.cubicTo(8.4, 18.0, 14.8, 17.0, 16.7, 12.7);
        crescent.cubicTo(10.8, 14.0, 7.3, 8.7, 10.3, 3.2);
        painter.drawPath(crescent);
    }
    painter.end();
    graphic.setDevicePixelRatio(2);
    return QIcon(graphic);
}

void setIconAction(QPushButton *control, const QIcon &icon, const QString &name)
{
    control->setIcon(icon);
    control->setAccessibleName(name);
    control->setToolTip(name);
}

QPushButton *iconButton(const char *objectName, const QIcon &icon, const QString &name)
{
    auto *control = button({});
    control->setObjectName(objectName);
    control->setProperty("accessIcon", true);
    control->setIconSize(QSize(20, 20));
    control->setFixedSize(38, 38);
    setIconAction(control, icon, name);
    return control;
}

class AtlasCard : public QWidget {
public:
    explicit AtlasCard(const QString &image) : world(image)
    {
        setMinimumHeight(208);
    }
protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        const QRectF area = rect().adjusted(0, 0, -1, -1);
        QLinearGradient color(area.topLeft(),area.bottomRight());
        color.setColorAt(0, lightAppearance() ? QColor("#f3f7ff") : QColor("#10182e"));
        color.setColorAt(1, lightAppearance() ? QColor("#d5e3fb") : QColor("#1b2b53"));
        painter.setBrush(color);
        painter.setPen(Qt::NoPen);
        painter.drawRect(area);
        if (world.isNull()) return;
        painter.setClipRect(area);
        painter.setRenderHint(QPainter::SmoothPixmapTransform);
        const qreal size = height() * 1.10;
        const bool narrow = width() < 345;
        painter.setOpacity(narrow ? .72 : .96);
        painter.drawImage(QRectF(width()-size*(narrow ? .50 : .79),height()*.075,size,size),world);
    }
private:
    QImage world;
};

QStringList walletFiles(const QString &data)
{
    auto names = QDir(data + walletDirectory).entryList({"*.keys"}, QDir::Files, QDir::Name);
    for (auto &name : names) name.chop(5);
    return names;
}

class AccessBrand final : public QWidget {
public:
    AccessBrand()
    {
        setMinimumWidth(225);
        auto *content = column(this, 36, 5);
        content->addStretch(1);
        auto *mark = new QLabel;
        mark->setPixmap(QApplication::windowIcon().pixmap(QSize(76, 76), devicePixelRatioF()));
        content->addWidget(mark, 0, Qt::AlignHCenter);
        auto *name = label("Noticoin", "accessBrand");
        auto *caption = label(ui("Wallet"), "accessBrandCaption");
        name->setAlignment(Qt::AlignCenter);
        caption->setAlignment(Qt::AlignCenter);
        content->addWidget(name);
        content->addWidget(caption);
        content->addStretch(1);
        auto *credits = label(ui("Map data") + " © OpenStreetMap contributors · © OpenMapTiles", "accessMapCredits", true);
        credits->setAlignment(Qt::AlignHCenter);
        content->addWidget(credits);
    }
protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        QLinearGradient surface(rect().topLeft(), rect().bottomRight());
        const bool light = lightAppearance();
        surface.setColorAt(0, light ? QColor("#e7effe") : QColor("#0b1225"));
        surface.setColorAt(.62, light ? QColor("#dce7fc") : QColor("#162247"));
        surface.setColorAt(1, light ? QColor("#d6ddfa") : QColor("#292d63"));
        painter.fillRect(rect(), surface);
        const qreal radius = qMax(width(), height()) * .34;
        const QPointF center(width() * .95, height() * .92);
        for (int ring = 1; ring <= 3; ++ring) {
            painter.setPen(QPen(light ? QColor(85, 115, 183, 45 - ring * 4)
                                       : QColor(149, 171, 255, 24 - ring * 4), 1.4));
            painter.drawEllipse(center, radius * ring / 2, radius * ring / 2);
        }
    }
};
}


WalletWindow::WalletWindow(QString root, QString data, quint16 regtestPort)
    : root(std::move(root)), data(std::move(data)), regtestPort(regtestPort)
{
    setWindowTitle(QApplication::applicationName());
    QSettings settings(this->data + "/wallet.ini", QSettings::IniFormat);
    light = settings.value("theme").toString() == "light";
    applyAppearance();
    const auto display = screen()->availableGeometry();
    const QSize minimum(qMin(940, display.width() - 32), qMin(600, display.height() - 54));
    const QSize preferred(qMin(1440, display.width() - 64), qMin(880, display.height() - 65));
    setMinimumSize(minimum);
    resize(preferred.expandedTo(minimum));
    move(display.center() - QPoint(width() / 2, height() / 2));
    stages = new QStackedWidget;
    setCentralWidget(stages);

    worker = new QObject;
    worker->moveToThread(&workerThread);
    connect(&workerThread, &QThread::finished, worker, &QObject::deleteLater);
    workerThread.start();
    timer = new QTimer(this);
    timer->setInterval(5000);
    connect(timer, &QTimer::timeout, this, &WalletWindow::refresh);
    timer->start();
    startup();
}

void WalletWindow::applyAppearance()
{
    QPalette colors = QApplication::palette();
    colors.setColor(QPalette::Window, light ? QColor("#fbfcff") : QColor("#0d1322"));
    colors.setColor(QPalette::WindowText, light ? QColor("#1d2a45") : QColor("#eaf0ff"));
    colors.setColor(QPalette::Base, light ? QColor("#fff") : QColor("#0c1425"));
    colors.setColor(QPalette::AlternateBase, light ? QColor("#f5f8fd") : QColor("#131e33"));
    colors.setColor(QPalette::Text, colors.color(QPalette::WindowText));
    colors.setColor(QPalette::Button, light ? QColor("#f3f6fd") : QColor("#19233a"));
    colors.setColor(QPalette::ButtonText, colors.color(QPalette::WindowText));
    colors.setColor(QPalette::Highlight, light ? QColor("#dfe8fc") : QColor("#293d68"));
    colors.setColor(QPalette::HighlightedText, light ? QColor("#243d82") : QColor("#f1f3ff"));
    colors.setColor(QPalette::PlaceholderText, light ? QColor("#61708e") : QColor("#8c9ab5"));
    colors.setColor(QPalette::ToolTipBase, colors.color(QPalette::Button));
    colors.setColor(QPalette::ToolTipText, colors.color(QPalette::WindowText));
    colors.setColor(QPalette::Link, light ? QColor("#405aba") : QColor("#b6c2ff"));
    QApplication::setPalette(colors);
    setStyleSheet(light ? QString::fromUtf8(theme) + QString::fromUtf8(lightTheme) : QString::fromUtf8(theme));
#ifdef Q_OS_WIN
    const BOOL darkTitle = !light;
    DwmSetWindowAttribute(reinterpret_cast<HWND>(winId()), 20, &darkTitle, sizeof(darkTitle));
#endif
    for (auto *control : findChildren<QPushButton *>("themeChoice")) {
        control->setText(light ? ui("Dark theme") : ui("Light theme"));
    }
    for (auto *control : findChildren<QPushButton *>("accessTheme")) {
        setIconAction(control, accessIcon(light ? AccessSymbol::Moon : AccessSymbol::Sun),
                      light ? ui("Dark theme") : ui("Light theme"));
    }
    for (auto *control : findChildren<QPushButton *>("accessLanguage")) control->setIcon(navIcon(World));
    for (auto *control : findChildren<QPushButton *>("accessExit")) control->setIcon(accessIcon(AccessSymbol::Exit));
    if (map) map->setLightTheme(light);
    if (workspace) {
        for (int i = 0; i < int(nav.size()); ++i) nav[i]->setIcon(navIcon(i));
        account->setIcon(navIcon(Wallets));
        for (int row = 0; row < history->rowCount(); ++row) {
            auto *value = history->item(row, 1);
            if (value && value->text().startsWith('+'))
                value->setForeground(light ? QColor("#16674e") : QColor("#94e7c1"));
        }
    }
}

QPushButton *WalletWindow::themeButton(bool compact)
{
    const auto name = light ? ui("Dark theme") : ui("Light theme");
    auto *toggle = compact ? iconButton("accessTheme", accessIcon(light ? AccessSymbol::Moon : AccessSymbol::Sun), name)
                           : button(name);
    if (!compact) toggle->setObjectName("themeChoice");
    connect(toggle, &QPushButton::clicked, this, [this] {
        light = !light;
        QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
        settings.setValue("theme", light ? "light" : "dark");
        applyAppearance();
    });
    return toggle;
}

void WalletWindow::buildWorkspace()
{
    auto *canvas = new QWidget;
    canvas->setObjectName("canvas");
    workspace = canvas;
    auto *shell = new QHBoxLayout(canvas);
    shell->setContentsMargins(0, 0, 0, 0);
    shell->setSpacing(0);
    auto *rail = new QWidget;
    rail->setObjectName("rail");
    rail->setFixedWidth(200);
    auto *railLayout = column(rail, 14, 5);
    auto *identity = new QHBoxLayout;
    identity->setContentsMargins(10, 15, 0, 3);
    identity->setSpacing(8);
    auto *mark = new QLabel;
    mark->setPixmap(QApplication::windowIcon().pixmap(QSize(30, 30), devicePixelRatioF()));
    identity->addWidget(mark);
    identity->addWidget(label("Noti", "brand"));
    identity->addStretch();
    railLayout->addLayout(identity);
    auto *railName = label("WALLET", "railMuted");
    railName->setContentsMargins(11,0,0,24);
    railLayout->addWidget(railName);
    const std::array<QString, 7> labels{ui("Overview"), ui("Send"), ui("Receive"), ui("History"), ui("World map"), ui("Wallets"), ui("Node")};
    for (int i = 0; i < int(labels.size()); ++i) {
        if (i == Wallets) railLayout->addSpacing(14);
        auto *link = new NavigationButton(labels[i]);
        link->setCheckable(true);
        link->setIcon(navIcon(i));
        link->setIconSize(QSize(18,18));
        connect(link, &QPushButton::clicked, this, [this, i] { showPage(Page(i)); });
        nav.push_back(link);
        railLayout->addWidget(link);
    }
    railLayout->addStretch();
    networkChip = label(ui("Node is off"), "railMuted", true);
    networkChip->setContentsMargins(10, 0, 8, 10);
    railLayout->addWidget(networkChip);
    shell->addWidget(rail);

    auto *main = new QWidget;
    main->setObjectName("workspace");
    auto *mainLayout = column(main, 0, 0);
    auto *header = new QWidget;
    header->setObjectName("header");
    auto *top = new QHBoxLayout(header);
    top->setContentsMargins(28, 16, 24, 16);
    pageTitle = label(ui("Overview"), "title");
    account = button(ui("Choose wallet"));
    account->setObjectName("chip");
    account->setIcon(navIcon(Wallets));
    auto *walletMenu = new QMenu(account);
    account->setMenu(walletMenu);
    connect(walletMenu, &QMenu::aboutToShow, this, [this, walletMenu] {
        walletMenu->clear();
        walletMenu->setMinimumWidth(account->width());
        auto names = walletFiles(data);
        if (!activeWallet.isEmpty() && !names.contains(activeWallet)) names.prepend(activeWallet);
        for (const auto &name : names) {
            auto *entry = walletMenu->addAction(QString(name).replace('&', "&&"));
            entry->setCheckable(true);
            entry->setChecked(name == activeWallet);
            connect(entry, &QAction::triggered, this, [this, name] {
                if (activeWallet.isEmpty()) walletAccess("open");
                else if (name != activeWallet) walletAccess("open", AccessRoute::Switch, name);
            });
        }
        if (!names.isEmpty()) walletMenu->addSeparator();
        walletMenu->addAction(ui("Wallets"), this, [this] { showPage(Wallets); });
    });
    top->addWidget(pageTitle);
    top->addStretch();
    top->addWidget(themeButton());
    top->addWidget(account);
    mainLayout->addWidget(header);
    pages = new QStackedWidget;
    pages->addWidget(overviewPage());
    pages->addWidget(sendPage());
    pages->addWidget(receivePage());
    pages->addWidget(historyPage());
    mapPage = new QWidget;
    column(mapPage);
    pages->addWidget(mapPage);
    pages->addWidget(walletPage());
    pages->addWidget(nodePage());
    mainLayout->addWidget(pages, 1);
    notification = label({}, "notification", true);
    notification->setParent(workspace);
    notification->setAttribute(Qt::WA_TransparentForMouseEvents);
    notification->hide();
    notificationTimer = new QTimer(notification);
    notificationTimer->setSingleShot(true);
    connect(notificationTimer, &QTimer::timeout, notification, &QWidget::hide);
    shell->addWidget(main, 1);
    stages->addWidget(workspace);
    updateActions();
}

void WalletWindow::openWorkspace(Page page, const QJsonObject &state)
{
    if (!workspace) {
        if (state["wallet"].toString().isEmpty()) return;
        buildWorkspace();
    }
    if (!state.isEmpty()) updateState(state);
    stages->setCurrentWidget(workspace);
    if (accessPage) {
        stages->removeWidget(accessPage);
        accessPage->deleteLater();
        accessPage = nullptr;
    }
    showPage(page);
}

WalletWindow::~WalletWindow()
{
    if (workerThread.isRunning()) {
        QMetaObject::invokeMethod(worker, [this] { service.reset(); }, Qt::BlockingQueuedConnection);
        workerThread.quit();
        workerThread.wait();
    }
}

QWidget *WalletWindow::overviewPage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26, 18);
    auto *hero = new QHBoxLayout;
    hero->setSpacing(16);
    auto *balanceCard = card();
    auto *funds = column(balanceCard, 24, 12);
    rowHeading(funds, label(ui("Wallet balance"), "heading", true), label("Noticoin", "currency"));
    balanceDetail = label(ui("Open a wallet to view its balance and recent activity."), "muted", true);
    auto *ledger = new QFrame;
    ledger->setObjectName("balanceTable");
    auto *amounts = new QGridLayout(ledger);
    amounts->setContentsMargins(14, 10, 14, 10);
    amounts->setHorizontalSpacing(10);
    amounts->setVerticalSpacing(8);
    amounts->setColumnStretch(0, 1);
    amounts->setColumnStretch(1, 2);
    balance = new BalanceAmount("balance");
    available = new BalanceAmount("availableValue");
    locked = new BalanceAmount("balanceValue");
    const auto addBalanceRow = [&](int row, const QString &caption, QLabel *value) {
        amounts->addWidget(label(caption, "field", true), row, 0);
        amounts->addWidget(value, row, 1);
        value->setAccessibleName(caption);
    };
    addBalanceRow(0, ui("Total balance"), balance);
    amounts->addWidget(sectionLine(), 1, 0, 1, 2);
    addBalanceRow(2, ui("Available"), available);
    amounts->addWidget(sectionLine(), 3, 0, 1, 2);
    addBalanceRow(4, ui("Locked"), locked);
    funds->addWidget(ledger);
    funds->addWidget(balanceDetail);
    funds->addStretch();
    setupOverview = button(ui("Open wallet"), true);
    sendOverview = button(ui("Send"), true);
    receiveOverview = button(ui("Receive"));
    connect(setupOverview, &QPushButton::clicked, this, [this] { showPage(Wallets); });
    connect(sendOverview, &QPushButton::clicked, this, [this] { showPage(Send); });
    connect(receiveOverview, &QPushButton::clicked, this, [this] { showPage(Receive); });
    requiresWallet.insert(requiresWallet.end(), {sendOverview, receiveOverview});
    requiresClosed.push_back(setupOverview);
    buttons(funds, {setupOverview, sendOverview, receiveOverview});
    auto *places = new AtlasCard(root + "/map/public/atlas/globe.png");
    auto *atlas = column(places, 24);
    atlas->addWidget(label(ui("World map"), "onAtlas"));
    auto *subtitle = label(ui("Pins and messages"), "atlasHint");
    atlas->addWidget(subtitle);
    atlas->addStretch();
    worldOverview = button(ui("Open map"));
    connect(worldOverview, &QPushButton::clicked, this, [this] { showPage(World); });
    buttons(atlas, {worldOverview});
    hero->addWidget(balanceCard, 6);
    hero->addWidget(places, 5);
    layout->addLayout(hero);
    auto *summary = new QHBoxLayout;
    summary->setSpacing(16);
    auto *activity = card();
    auto *operations = column(activity, 22, 10);
    auto *all = button(ui("History"));
    connect(all, &QPushButton::clicked, this, [this] { showPage(History); });
    rowHeading(operations, label(ui("Recent activity"), "heading", true), all);
    operations->addWidget(sectionLine());
    recentEmpty = label(ui("Open a wallet to view recent activity."), "muted", true);
    operations->addWidget(recentEmpty);
    recentRows = new QVBoxLayout;
    recentRows->setSpacing(10);
    operations->addLayout(recentRows);
    operations->addStretch();
    summary->addWidget(activity, 7);
    auto *connection = card();
    auto *info = column(connection, 22, 10);
    info->addWidget(label(ui("Noticoin node"), "heading"));
    overviewConnection = label(ui("Node is off"), "cardValue", true);
    overviewHeight = label({}, "muted", true);
    overviewHeight->hide();
    info->addWidget(overviewConnection);
    info->addWidget(overviewHeight);
    info->addStretch();
    auto *nodeSettings = button(ui("View node status"));
    connect(nodeSettings, &QPushButton::clicked, this, [this] { showPage(Node); });
    buttons(info, {nodeSettings});
    summary->addWidget(connection, 4);
    layout->addLayout(summary);
    layout->addStretch();
    return scrollPage(body);
}

QWidget *WalletWindow::sendPage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26, 15);
    auto *columns = new QHBoxLayout;
    columns->setSpacing(16);
    auto *panel = card();
    auto *form = column(panel, 24, 11);
    form->addWidget(label(ui("New transfer"), "heading"));
    toAddress = addressBox(ui("Recipient address"));
    toAddress->setPlaceholderText(ui("Paste a Noticoin address"));
    auto *paste = button(ui("Paste"));
    paste->setAccessibleName(ui("Paste recipient address"));
    connect(paste, &QPushButton::clicked, this, [this] {
        const auto clip = QApplication::clipboard()->text().trimmed();
        if (!clip.isEmpty()) toAddress->setPlainText(clip);
        toAddress->setFocus();
    });
    auto *addressBook = button(ui("Address book"));
    requiresWallet.push_back(addressBook);
    connect(addressBook, &QPushButton::clicked, this, &WalletWindow::showAddressBook);
    auto *addressActions = new QWidget;
    auto *addressButtons = new QHBoxLayout(addressActions);
    addressButtons->setContentsMargins(0, 0, 0, 0);
    addressButtons->setSpacing(7);
    addressButtons->addWidget(addressBook);
    addressButtons->addWidget(paste);
    auto *addressCaption = label(ui("Recipient address"), "field");
    addressCaption->setBuddy(toAddress);
    rowHeading(form, addressCaption, addressActions);
    form->addWidget(toAddress);

    auto *moneyRow = new QHBoxLayout;
    moneyRow->setSpacing(10);
    amount = new QLineEdit;
    amount->setObjectName("amountValue");
    amount->setPlaceholderText("0.00");
    new FieldAccent(amount);
    moneyRow->addWidget(amount, 1);
    maxButton = button(ui("Max"));
    maxButton->setObjectName("maximum");
    maxButton->setCheckable(true);
    maxButton->setToolTip(ui("All spendable funds minus fees"));
    moneyRow->addWidget(label("Noticoin", "field"));
    moneyRow->addWidget(maxButton, 0, Qt::AlignVCenter);
    maxHint = label(ui("All spendable funds minus fees"), "muted", true);
    maxHint->hide();
    maximumQuoteTimer = new QTimer(this);
    maximumQuoteTimer->setSingleShot(true);
    maximumQuoteTimer->setInterval(40);
    connect(maximumQuoteTimer, &QTimer::timeout, this, &WalletWindow::quoteMaximum);
    connect(maxButton, &QPushButton::clicked, this, [this] { setMaximum(true); });
    connect(amount, &QLineEdit::textEdited, this, [this] { setMaximum(false); });
    amount->setAccessibleName(ui("Amount in Noticoin"));
    auto *amountCaption = label(ui("Transfer amount"), "field");
    amountCaption->setBuddy(amount);
    form->addWidget(amountCaption);
    form->addLayout(moneyRow);
    sendBalance = label(ui("Available to send") + "  ·  — Noticoin", "field", true);
    form->addWidget(sendBalance);
    form->addWidget(maxHint);
    auto *review = button(ui("Review transfer"), true);
    requiresWallet.push_back(review);
    connect(review, &QPushButton::clicked, this, &WalletWindow::send);
    connect(amount, &QLineEdit::returnPressed, review, &QPushButton::click);
    buttons(form, {review});
    columns->addWidget(panel, 7);

    auto *context = card();
    auto *details = column(context, 21, 11);
    details->addWidget(label(ui("Fee"), "heading", true));
    feePriority = new AnimatedCombo;
    feePriority->setObjectName("transferPriority");
    for (size_t i = 0; i < feePriorities.size(); ++i) feePriority->addItem(ui(feePriorities[i]), int(i) + 1);
    feePriority->setCurrentIndex(1);
    field(details, ui("Transfer priority"), feePriority);
    connect(feePriority, &QComboBox::currentIndexChanged, this, &WalletWindow::scheduleMaximumQuote);
    feeQuote = label(ui("The fee and total appear when you review the transfer."), "muted", true);
    feeQuote->setObjectName("transferFee");
    details->addWidget(feeQuote);
    sendOpen = button(ui("Choose wallet"));
    connect(sendOpen, &QPushButton::clicked, this, [this] { showPage(Wallets); });
    buttons(details, {sendOpen});
    details->addStretch();
    columns->addWidget(context, 4);
    layout->addLayout(columns);
    layout->addStretch();
    return scrollPage(body);
}

QWidget *WalletWindow::receivePage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26, 15);
    auto *columns = new QHBoxLayout;
    columns->setSpacing(16);
    auto *panel = card();
    auto *form = column(panel, 24, 12);
    form->addWidget(label(ui("Receiving address"), "heading"));
    receiveField = addressBox(ui("Noticoin receiving address"), true);
    receiveField->setPlaceholderText(ui("Open a wallet to get an address"));
    receiveKind = label(ui("Primary address"), "walletBadge");
    form->addWidget(receiveKind, 0, Qt::AlignLeft);
    form->addWidget(receiveField);
    auto *copy = button(ui("Copy"), true);
    copy->setAccessibleName(ui("Copy receiving address"));
    auto *newAddress = button(ui("New subaddress"));
    primaryAddress = button(ui("Show primary address"));
    requiresWallet.push_back(copy);
    requiresWallet.push_back(newAddress);
    requiresWallet.push_back(primaryAddress);
    connect(primaryAddress, &QPushButton::clicked, this, [this] { setReceiveAddress(publicAddress); });
    connect(copy, &QPushButton::clicked, this, [this] { copyAddress(receiveAddress); });
    connect(newAddress, &QPushButton::clicked, this, [this] {
        transact(ui("Creating subaddress"), [](WalletService &wallet) {
            const auto address = wallet.subaddress();
            return QJsonObject{{"address", address}, {"subaddresses", wallet.subaddresses()}};
        }, [this](const QJsonValue &result) {
            const auto created = result.toObject();
            updateSubaddresses(created["subaddresses"].toArray());
            setReceiveAddress(created["address"].toString(), true);
            notify(ui("Subaddress ready"));
        });
    });
    buttons(form, {copy, newAddress});
    form->addWidget(primaryAddress, 0, Qt::AlignLeft);
    receiveOpen = button(ui("Choose wallet"));
    connect(receiveOpen, &QPushButton::clicked, this, [this] { showPage(Wallets); });
    form->addWidget(receiveOpen, 0, Qt::AlignLeft);
    form->addStretch();
    columns->addWidget(panel, 7);

    auto *scan = card();
    auto *qrPanel = column(scan, 20, 11);
    qrPanel->addWidget(label(ui("Address QR code"), "heading"));
    auto *well = new QFrame;
    well->setObjectName("codeWell");
    auto *qrLayout = column(well, 10, 0);
    receiveQr = label(ui("Open a wallet to show the QR code"), "receiveQr", true);
    receiveQr->setAlignment(Qt::AlignCenter);
    receiveQr->setAccessibleName(ui("Receiving address QR code"));
    receiveQr->setFixedSize(170, 170);
    qrLayout->addWidget(receiveQr, 0, Qt::AlignCenter);
    qrPanel->addWidget(well);
    qrPanel->addWidget(label(ui("Scan to get the address."), "muted", true));
    qrPanel->addStretch();
    columns->addWidget(scan, 4);
    layout->addLayout(columns);
    auto *list = card();
    auto *entries = column(list, 20, 10);
    entries->addWidget(label(ui("Subaddresses"), "heading", true));
    subaddressesEmpty = label(ui("No subaddresses yet."), "muted", true);
    entries->addWidget(subaddressesEmpty);
    subaddressesHint = label(ui("Click an address to copy it."), "muted", true);
    subaddressesHint->hide();
    entries->addWidget(subaddressesHint);
    subaddressTable = new QTableWidget(0, 3);
    subaddressTable->setHorizontalHeaderLabels({ui("Index"), ui("Address"), ui("Status")});
    subaddressTable->horizontalHeader()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    subaddressTable->horizontalHeader()->setSectionResizeMode(1, QHeaderView::Stretch);
    subaddressTable->horizontalHeader()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
    subaddressTable->verticalHeader()->hide();
    subaddressTable->verticalHeader()->setDefaultSectionSize(42);
    subaddressTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    subaddressTable->setSelectionBehavior(QAbstractItemView::SelectRows);
    subaddressTable->setSelectionMode(QAbstractItemView::SingleSelection);
    subaddressTable->setAlternatingRowColors(true);
    subaddressTable->setWordWrap(false);
    subaddressTable->setMouseTracking(true);
    subaddressTable->hide();
    connect(subaddressTable, &QTableWidget::currentCellChanged, this, [this](int row) {
        if (row < 0 || activeWallet.isEmpty()) return;
        if (const auto *item = subaddressTable->item(row, 1)) setReceiveAddress(item->text(), true);
    });
    connect(subaddressTable, &QTableWidget::cellClicked, this, [this](int row, int column) {
        if (column != 1 || activeWallet.isEmpty()) return;
        if (const auto *item = subaddressTable->item(row, column)) {
            const auto address = item->text();
            setReceiveAddress(address, true);
            copyAddress(address);
        }
    });
    connect(subaddressTable, &QTableWidget::cellEntered, this, [this](int, int column) {
        subaddressTable->viewport()->setCursor(column == 1 ? Qt::PointingHandCursor : Qt::ArrowCursor);
    });
    connect(subaddressTable, &QTableWidget::viewportEntered, this, [this] {
        subaddressTable->viewport()->unsetCursor();
    });
    entries->addWidget(subaddressTable);
    layout->addWidget(list);
    layout->addStretch();
    return scrollPage(body);
}

namespace {
QString transactionLabel(const QJsonObject &tx)
{
    const auto operation = tx["mapOperation"].toString();
    if (operation == "publish") return ui("Map publication fee");
    if (operation == "withdraw") return ui("Map pin removal");
    if (tx["mapPurchase"].toBool()) return ui(tx["confirmations"].toInteger() ? "Map note purchased" : "Map note purchase pending");
    if (tx["selfTransfer"].toBool()) return ui("Transfer to own wallet");
    const auto kind = tx["kind"].toString();
    return kind == "in" || kind == "pool" ? ui("Received") : ui("Sent");
}

QList<QPair<QString, QString>> transactionFields(const QJsonObject &tx)
{
    const auto kind = tx["kind"].toString();
    const bool incoming = kind == "in" || kind == "pool";
    const auto confirmations = tx["confirmations"].toInteger();
    const auto when = tx["time"].toInteger();
    QList<QPair<QString, QString>> fields{
        {ui("Transaction ID"), tx["id"].toString()},
        {ui("Status"), transactionLabel(tx) + " · "
                       + (confirmations ? ui("Confirmed") : ui("Pending"))},
        {ui("Amount"), tx["amount"].toString() + " Noticoin"},
        {ui("Confirmations"), QString::number(confirmations)}
    };
    if (tx["selfTransfer"].toBool() && tx["fee"].toString() != "0")
        fields.insert(3, {ui("Balance change"), "−" + tx["fee"].toString() + " Noticoin"});
    if (!tx["mapPoint"].toString().isEmpty()) fields.append({ui("Map pin ID"), tx["mapPoint"].toString()});
    if (when) fields.append({ui("Date"), QDateTime::fromSecsSinceEpoch(when).toLocalTime().toString("dd.MM.yyyy HH:mm")});
    if (confirmations) fields.append({ui("Block height"), QString::number(tx["height"].toInteger())});
    if (!incoming || tx["fee"].toString() != "0") fields.append({ui("Fee"), tx["fee"].toString() + " Noticoin"});
    for (const auto &address : tx["addresses"].toArray())
        fields.append({incoming ? ui("Receiving address") : ui("Recipient address"), address.toString()});
    return fields;
}

QString transactionText(const QList<QPair<QString, QString>> &fields)
{
    QStringList lines;
    for (const auto &[label, value] : fields) lines << label + ": " + value;
    return lines.join('\n');
}
}

QWidget *WalletWindow::historyPage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26);
    history = new QTableWidget(0, 4);
    history->setObjectName("historyTable");
    history->setHorizontalHeaderLabels({ui("Transaction"), ui("Amount"), ui("Date"), ui("Confirmations")});
    history->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    history->verticalHeader()->hide();
    history->verticalHeader()->setDefaultSectionSize(43);
    history->setEditTriggers(QAbstractItemView::NoEditTriggers);
    history->setSelectionBehavior(QAbstractItemView::SelectRows);
    history->setAlternatingRowColors(true);
    history->setShowGrid(false);
    history->setContextMenuPolicy(Qt::CustomContextMenu);
    layout->addWidget(history, 1);
    connect(history, &QTableWidget::cellDoubleClicked, this, [this](int row, int) {
        const auto *item = history->item(row, 0);
        if (item) showTransaction(item->data(Qt::UserRole).toJsonObject());
    });
    connect(history, &QTableWidget::customContextMenuRequested, this, [this](const QPoint &position) {
        const auto index = history->indexAt(position);
        const auto *item = index.isValid() ? history->item(index.row(), 0) : nullptr;
        if (!item) return;
        const auto tx = item->data(Qt::UserRole).toJsonObject();
        const auto date = history->item(index.row(), 2)->text();
        history->selectRow(index.row());
        QMenu menu(history);
        menu.addAction(ui("Info"), this, [this, tx] { showTransaction(tx); });
        menu.addSeparator();
        menu.addAction(ui("Copy transaction ID"), this, [this, tx] {
            QApplication::clipboard()->setText(tx["id"].toString());
            notify(ui("Transaction ID copied"));
        });
        menu.addAction(ui("Copy amount"), this, [this, tx] {
            QApplication::clipboard()->setText(tx["amount"].toString());
            notify(ui("Copied"));
        });
        auto *copyDate = menu.addAction(ui("Copy date"), this, [this, date] {
            QApplication::clipboard()->setText(date);
            notify(ui("Copied"));
        });
        copyDate->setEnabled(tx["time"].toInteger() > 0);
        menu.addAction(ui("Copy all details"), this, [this, tx] {
            QApplication::clipboard()->setText(transactionText(transactionFields(tx)));
            notify(ui("Copied"));
        });
        menu.exec(history->viewport()->mapToGlobal(position));
    });
    return body;
}

void WalletWindow::showTransaction(const QJsonObject &tx)
{
    if (tx["id"].toString().isEmpty()) return;
    const auto fields = transactionFields(tx);

    QDialog dialog(this);
    dialog.setWindowTitle(ui("Transaction details"));
    dialog.resize(680, 520);
    auto *form = column(&dialog, 22);
    form->addWidget(label(ui("Transaction details"), "heading"));
    auto *content = new QWidget;
    auto *rows = column(content, 0, 7);
    for (const auto &[name, value] : fields) {
        auto *row = new QHBoxLayout;
        row->setSpacing(8);
        auto *display = new QLineEdit(value);
        display->setReadOnly(true);
        display->setAccessibleName(name);
        display->setCursorPosition(0);
        auto *copy = button(ui("Copy"));
        copy->setAccessibleName(ui("Copy") + " " + name);
        connect(copy, &QPushButton::clicked, &dialog, [this, value] {
            QApplication::clipboard()->setText(value);
            notify(ui("Copied"));
        });
        row->addWidget(display, 1);
        row->addWidget(copy);
        rows->addWidget(label(name, "field"));
        rows->addLayout(row);
    }
    auto *scroll = new QScrollArea;
    scroll->setWidgetResizable(true);
    scroll->setWidget(content);
    form->addWidget(scroll, 1);
    auto *copy = button(ui("Copy all details"));
    connect(copy, &QPushButton::clicked, &dialog, [this, details = transactionText(fields)] {
        QApplication::clipboard()->setText(details);
        notify(ui("Copied"));
    });
    auto *done = button(ui("Close"), true);
    connect(done, &QPushButton::clicked, &dialog, &QDialog::accept);
    dialogButtons(form, {copy, done});
    dialog.exec();
}

QWidget *WalletWindow::walletPage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26);
    auto *panel = card();
    auto *controls = column(panel, 24);
    controls->addWidget(label(ui("Wallets on this computer"), "heading"));
    controls->addWidget(label(ui("Create a wallet, open an existing one, or restore it from a recovery phrase."), "muted", true));
    auto *open = button(ui("Open"), true);
    auto *create = button(ui("Create"));
    auto *restore = button(ui("Restore"));
    auto *seed = button(ui("Recovery phrase"));
    auto *close = button(ui("Close wallet"));
    requiresClosed.insert(requiresClosed.end(), {open, create, restore});
    requiresWallet.insert(requiresWallet.end(), {seed, close});
    connect(open, &QPushButton::clicked, this, [this] { walletAccess("open"); });
    connect(create, &QPushButton::clicked, this, [this] { walletAccess("create"); });
    connect(restore, &QPushButton::clicked, this, [this] { walletAccess("restore"); });
    connect(seed, &QPushButton::clicked, this, &WalletWindow::showSeed);
    connect(close, &QPushButton::clicked, this, [this] {
        transact(ui("Saving wallet"), [](WalletService &wallet) { return wallet.close(); },
                 [this](const QJsonValue &state) {
            updateState(state.toObject());
            chooseWalletAction();
        });
    });
    buttons(controls, {open, create, restore});
    buttons(controls, {seed, close});
    layout->addWidget(panel);
    layout->addStretch();
    return scrollPage(body);
}

QWidget *WalletWindow::nodePage()
{
    auto *body = new QWidget;
    auto *layout = column(body, 26, 16);
    auto *network = card();
    auto *connection = column(network, 24, 16);
    nodeState = label(ui("Node is off"), "walletBadge", true);
    rowHeading(connection, label(ui("Noticoin network connection"), "heading", true), nodeState);

    auto *statistics = new QHBoxLayout;
    statistics->setSpacing(12);
    auto *height = new QFrame;
    height->setObjectName("inset");
    auto *heightColumn = column(height, 16, 7);
    heightColumn->addWidget(label(ui("Blockchain height"), "field", true));
    nodeHeight = label("—", "cardNumber", true);
    heightColumn->addWidget(nodeHeight);
    statistics->addWidget(height, 1);

    auto *peers = new QFrame;
    peers->setObjectName("inset");
    auto *peersColumn = column(peers, 16, 7);
    auto *show = button(ui("Show"));
    show->setObjectName("showPeers");
    requiresWallet.push_back(show);
    connect(show, &QPushButton::clicked, this, &WalletWindow::showPeers);
    rowHeading(peersColumn, label(ui("Peers"), "field", true), show);
    nodePeers = label("—", "cardNumber", true);
    peersColumn->addWidget(nodePeers);
    statistics->addWidget(peers, 1);
    connection->addLayout(statistics);
    layout->addWidget(network);
    layout->addStretch();
    return scrollPage(body);
}

void WalletWindow::showPage(Page page)
{
    if (page == World && (activeWallet.isEmpty() || !map)) return;
    pages->setCurrentIndex(page);
    notification->hide();
    for (int i = 0; i < int(nav.size()); ++i) nav[i]->setChecked(i == page);
    pageTitle->setText(nav[page]->text());
    if (page == Send) scheduleMaximumQuote();
    if (page == History || page == Receive || page == Send) refresh();
    else if (page == Overview) QTimer::singleShot(0, this, [this] {
        if (pages->currentIndex() == Overview) refresh();
    });
}

void WalletWindow::alert(const QString &title, const QString &message)
{
    QDialog dialog(this);
    dialog.setWindowTitle(title);
    dialog.setMinimumWidth(405);
    dialog.setMaximumWidth(590);
    auto *contents = column(&dialog, 24, 12);
    contents->addWidget(label(title, "heading", true));
    auto *copyable = label(message, "muted", true);
    copyable->setTextInteractionFlags(Qt::TextSelectableByMouse | Qt::TextSelectableByKeyboard);
    contents->addWidget(copyable);
    auto *done = button(ui("Done"), true);
    connect(done, &QPushButton::clicked, &dialog, &QDialog::accept);
    dialogButtons(contents, {done});
    done->setDefault(true);
    done->setFocus();
    dialog.exec();
}

void WalletWindow::notify(const QString &message, int duration)
{
    notification->setText(message);
    notification->setMaximumWidth(qMin(workspace->width() - 40, 420));
    notification->adjustSize();
    notification->move(workspace->width() - notification->width() - 24,
                       workspace->height() - notification->height() - 24);
    notification->raise();
    notification->show();
    notificationTimer->stop();
    if (duration > 0) notificationTimer->start(duration);
}

void WalletWindow::transact(QString label, std::function<QJsonValue(WalletService &)> work,
                            std::function<void(QJsonValue)> ready, bool showErrors,
                            std::function<void(const QString &)> failed)
{
    if (busy) return;
    busy = true;
    const bool progress = workspace && stages->currentWidget() == workspace && !label.isEmpty();
    if (progress) notify(label + "…", 0);
    updateActions();
    QMetaObject::invokeMethod(worker, [this, work = std::move(work), ready = std::move(ready), showErrors, progress,
                                      failed = std::move(failed)] {
        QString failure;
        QJsonValue result;
        try {
            if (!service) service = std::make_unique<WalletService>(root, data, false, regtestPort);
            result = work(*service);
        } catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        QMetaObject::invokeMethod(this, [this, failure, result, ready, showErrors, failed, progress] {
            busy = false;
            updateActions();
            if (progress) notification->hide();
            if (!failure.isEmpty()) {
                if (failed) failed(failure);
                else if (showErrors) alert(ui("Action failed"), failure);
                return;
            }
            if (ready) ready(result);
        }, Qt::QueuedConnection);
    }, Qt::QueuedConnection);
}

void WalletWindow::updateActions()
{
    if (!workspace) return;
    const bool open = !activeWallet.isEmpty();
    account->setEnabled(!busy);
    nav[World]->setEnabled(open);
    worldOverview->setEnabled(open);
    const auto mapHint = open ? QString{} : ui("Open a wallet first.");
    nav[World]->setToolTip(mapHint);
    worldOverview->setToolTip(mapHint);
    setupOverview->setVisible(!open);
    sendOverview->setVisible(open);
    receiveOverview->setVisible(open);
    balanceDetail->setVisible(!open);
    sendOpen->setVisible(!open);
    receiveOpen->setVisible(!open);
    receiveKind->setVisible(open);
    primaryAddress->setVisible(open && receiveAddress != publicAddress);
    for (auto *action : requiresWallet) action->setEnabled(open && !busy);
    for (auto *action : requiresClosed) action->setEnabled(!open && !busy);
    maxButton->setEnabled(open && !busy && !spendable.isEmpty() && spendable != "0");
}

void WalletWindow::updateState(const QJsonObject &state)
{
    const auto name = state["wallet"].toString();
    const bool changed = name != activeWallet;
    activeWallet = name;
    publicAddress = state["address"].toString();
    if (changed) {
        delete std::exchange(map, nullptr);
        if (name.isEmpty()) {
            if (pages->currentIndex() == World) showPage(Wallets);
        } else {
            map = new MapView(root, data, publicAddress, regtestPort != 0, [this](const QUrl &uri) { invoice(uri); },
                              [this](const QJsonObject &request) { mapWalletRequest(request); }, mapPage);
            map->setLightTheme(light);
            mapPage->layout()->addWidget(map);
            QTimer::singleShot(0, map, &MapView::start);
        }
        setMaximum(false);
        amount->clear();
        toAddress->clear();
        setReceiveAddress(publicAddress);
        updateSubaddresses({});
        history->setRowCount(0);
        updateRecent({});
    }
    account->setText(name.isEmpty() ? ui("Choose wallet") : account->fontMetrics().elidedText(name, Qt::ElideRight, 205));
    account->setAccessibleName(name.isEmpty() ? ui("Choose wallet") : name);
    account->setToolTip(name);
    balance->setText(name.isEmpty() ? "—" : state["balance"].toString());
    available->setText(name.isEmpty() ? "—" : state["available"].toString());
    locked->setText(name.isEmpty() ? "—" : state["locked"].toString());
    const auto balanceChanged = spendable != state["available"].toString();
    spendable = state["available"].toString();
    if (maximum && balanceChanged) {
        if (spendable.isEmpty() || spendable == "0") {
            setMaximum(false);
            amount->setText("0");
        } else scheduleMaximumQuote();
    }
    sendBalance->setText(ui("Available to send") + "  ·  " + (spendable.isEmpty() ? "—" : spendable) + " Noticoin");
    if (state.contains("subaddresses")) updateSubaddresses(state["subaddresses"].toArray());
    const auto peers = state["peers"].toInt();
    const auto height = state["height"].toString();
    networkChip->setText(height.isEmpty() ? ui("Node is off") : peers ? ui("Node connected") : ui("Node · no peers"));
    overviewConnection->setText(networkChip->text());
    overviewHeight->setVisible(!height.isEmpty());
    overviewHeight->setText(ui("Height ") + height + ui("  ·  Peers ") + QString::number(peers));
    nodeHeight->setText(height.isEmpty() ? "—" : height);
    nodePeers->setText(height.isEmpty() ? "—" : QString::number(peers));
    nodeState->setText(networkChip->text());
    if (state.contains("history")) {
        const auto entries = state["history"].toArray();
        updateRecent(entries);
        history->setRowCount(int(entries.size()));
        int row = 0;
        for (const auto &entry : entries) {
            const auto tx = entry.toObject();
            const auto kind = tx["kind"].toString();
            const bool incoming = kind == "in" || kind == "pool";
            const bool self = tx["selfTransfer"].toBool();
            const QColor color = self ? QColor(light ? "#425578" : "#c4d0ec")
                : incoming ? QColor(light ? "#16674e" : "#94e7c1") : QColor(light ? "#a12544" : "#ffadb4");
            auto *nameItem = new QTableWidgetItem(transactionLabel(tx));
            nameItem->setData(Qt::UserRole, tx);
            nameItem->setForeground(color);
            history->setItem(row, 0, nameItem);
            auto *moneyItem = new QTableWidgetItem((self ? "" : incoming ? "+" : "−") + tx["amount"].toString() + " Noticoin");
            moneyItem->setForeground(color);
            history->setItem(row, 1, moneyItem);
            const auto when = tx["time"].toInteger();
            history->setItem(row, 2, new QTableWidgetItem(when ? QDateTime::fromSecsSinceEpoch(when).toLocalTime().toString("dd.MM.yyyy HH:mm") : "—"));
            history->setItem(row++, 3, new QTableWidgetItem(QString::number(tx["confirmations"].toInteger())));
        }
    }
    notifyIncoming(state, changed);
    updateActions();
}

void WalletWindow::notifyIncoming(const QJsonObject &state, bool opening)
{
    if (opening) {
        seenIncoming.clear();
        incomingFromHeight = state["height"].toString().toLongLong();
    }
    if (activeWallet.isEmpty()) return;
    QHash<QString, quint64> received;
    for (const auto &entry : state["incoming"].toArray()) {
        const auto transfer = entry.toObject();
        const auto id = transfer["id"].toString();
        const auto value = transfer["amount"].toString();
        if (id.isEmpty() || value.isEmpty() || value == "0" || seenIncoming.contains(id)) continue;
        if (!transfer["pooled"].toBool() && transfer["height"].toInteger() < incomingFromHeight) continue;
        received[id] += parseMoney(value);
    }
    for (auto entry = received.cbegin(); entry != received.cend(); ++entry) seenIncoming.insert(entry.key());
    if (opening || received.isEmpty()) return;
    if (received.size() == 1) notify(ui("Received %1 Noticoin").arg(money(*received.cbegin())), 5500);
    else notify(ui("%1 new incoming transfers").arg(received.size()), 5500);
}

void WalletWindow::mapWalletRequest(const QJsonObject &request)
{
    if (!map || activeWallet.isEmpty() || closing) return;
    const auto id = request["id"].toString();
    static const QRegularExpression idFormat("^[a-f0-9-]{36}$");
    if (!idFormat.match(id).hasMatch()) return;
    if (busy || stages->currentWidget() != workspace || account->menu()->isVisible()) {
        map->walletReply(id, {{"error", ui("The wallet is busy. Try again.")}});
        return;
    }
    const auto method = request["method"].toString();
    const auto args = request["args"].toObject();
    if (method != "sale-address" && method != "sale-addresses" && method != "donation-addresses" && method != "note-publication-height" && method != "note-registry-policy" &&
        method != "sign-payment" && method != "verify-payment") return;
    const QPointer<MapView> target(map);
    transact({}, [method, args](WalletService &wallet) -> QJsonValue {
        if (method == "sale-address") return wallet.subaddress();
        if (method == "sale-addresses") return wallet.mapNoteAddresses(args["count"].toInt());
        if (method == "donation-addresses") return wallet.donationAddresses(args["create"].toBool());
        if (method == "note-publication-height") return wallet.nextMapPublicationHeight();
        if (method == "note-registry-policy") return wallet.mapNoteRegistryPolicy(args["height"].toInteger());
        if (method == "sign-payment") return wallet.signMapNotePayment(args);
        return wallet.verifyMapNotePayment(args);
    }, [target, id](const QJsonValue &value) { if (target) target->walletReply(id, {{"value", value}}); }, false,
       [target, id](const QString &error) { if (target) target->walletReply(id, {{"error", error}}); });
}

void WalletWindow::setReceiveAddress(const QString &address, bool subaddress)
{
    const bool changed = receiveAddress != address;
    receiveAddress = address;
    receiveKind->setText(subaddress ? ui("Subaddress") : ui("Primary address"));
    primaryAddress->setVisible(subaddress);
    const QSignalBlocker previous(subaddressTable);
    if (subaddress) {
        const auto rows = subaddressTable->findItems(address, Qt::MatchExactly);
        if (!rows.isEmpty()) subaddressTable->selectRow(rows.first()->row());
    } else {
        subaddressTable->clearSelection();
        subaddressTable->setCurrentItem(nullptr);
    }
    if (!changed) return;
    receiveField->setPlainText(address);
    if (address.isEmpty()) {
        receiveQr->setText(ui("Open a wallet to show the QR code"));
        return;
    }
    const auto code = addressQr(address, 168, receiveQr->devicePixelRatioF());
    receiveQr->setPixmap(QPixmap::fromImage(code));
}

void WalletWindow::copyAddress(const QString &address)
{
    if (address.isEmpty()) return;
    QApplication::clipboard()->setText(address);
    notify(ui("Address copied"));
}

void WalletWindow::updateSubaddresses(const QJsonArray &entries)
{
    if (entries == savedSubaddresses) return;
    savedSubaddresses = entries;
    const QSignalBlocker previous(subaddressTable);
    subaddressTable->clearContents();
    subaddressTable->setRowCount(int(entries.size()));
    QFont addressFont("Consolas");
    addressFont.setUnderline(true);
    for (int row = 0; row < subaddressTable->rowCount(); ++row) {
        const auto entry = entries[row].toObject();
        const auto address = entry["address"].toString();
        auto *index = new QTableWidgetItem(QString::number(entry["index"].toInteger()));
        index->setTextAlignment(Qt::AlignCenter);
        auto *item = new QTableWidgetItem(address);
        item->setFont(addressFont);
        item->setToolTip(address);
        subaddressTable->setItem(row, 0, index);
        subaddressTable->setItem(row, 1, item);
        subaddressTable->setItem(row, 2, new QTableWidgetItem(entry["used"].toBool() ? ui("Used") : ui("Unused")));
        if (receiveAddress == address) subaddressTable->selectRow(row);
    }
    subaddressTable->setFixedHeight(44 + 42 * qBound(1, subaddressTable->rowCount(), 6));
    subaddressTable->setVisible(!entries.isEmpty());
    subaddressesEmpty->setVisible(entries.isEmpty());
    subaddressesHint->setVisible(!entries.isEmpty());
}

void WalletWindow::updateRecent(const QJsonArray &entries)
{
    while (auto *item = recentRows->takeAt(0)) {
        delete item->widget();
        delete item;
    }
    recentEmpty->setVisible(entries.isEmpty());
    recentEmpty->setText(activeWallet.isEmpty() ? ui("Open a wallet to view recent activity.") : ui("No transactions yet."));
    for (qsizetype i = 0; i < qMin<qsizetype>(entries.size(), 4); ++i) {
        const auto tx = entries.at(i).toObject();
        const auto kind = tx["kind"].toString();
        const bool incoming = kind == "in" || kind == "pool";
        const bool self = tx["selfTransfer"].toBool();
        auto *row = new QWidget;
        auto *line = new QHBoxLayout(row);
        line->setContentsMargins(0, 0, 0, 0);
        line->setSpacing(10);
        auto *arrow = label(self ? "↔" : incoming ? "↓" : "↑", self ? "cardValue" : incoming ? "arrowIn" : "arrowOut");
        arrow->setAlignment(Qt::AlignCenter);
        arrow->setFixedSize(36, 36);
        line->addWidget(arrow);
        auto *summary = new QVBoxLayout;
        summary->setSpacing(1);
        summary->addWidget(label(transactionLabel(tx), "cardValue"));
        const auto time = tx["time"].toInteger();
        const auto date = time ? QDateTime::fromSecsSinceEpoch(time).toLocalTime().toString("dd.MM.yy HH:mm") : QString{};
        const auto caption = tx["confirmations"].toInteger() == 0
            ? QString(ui("Pending")) : date;
        summary->addWidget(label(caption, "field"));
        line->addLayout(summary, 1);
        auto *value = label((self ? "" : incoming ? "+" : "−") + tx["amount"].toString() + " Noticoin",
                            self ? "cardValue" : incoming ? "incomingAmount" : "outgoingAmount", true);
        value->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        line->addWidget(value);
        recentRows->addWidget(row);
    }
}

void WalletWindow::refresh()
{
    if (!workspace || stages->currentWidget() != workspace || activeWallet.isEmpty() || closing || account->menu()->isVisible()) return;
    const bool withHistory = pages->currentIndex() == History || pages->currentIndex() == Overview;
    const bool withAddresses = pages->currentIndex() == Receive;
    transact({}, [withHistory, withAddresses](WalletService &wallet) { return wallet.snapshot(withHistory, withAddresses, true); },
             [this](const QJsonValue &value) { updateState(value.toObject()); }, false);
}

QVBoxLayout *WalletWindow::accessPanel(const QString &title, const QString &description,
                                      bool languagePicker, bool showExit)
{
    auto *screen = new QWidget;
    screen->setObjectName("accessScreen");
    auto *split = new QHBoxLayout(screen);
    split->setContentsMargins(0, 0, 0, 0);
    split->setSpacing(0);
    split->addWidget(new AccessBrand, 2);

    auto *access = new QWidget;
    access->setObjectName("accessSurface");
    auto *accessLayout = column(access, 0, 0);
    split->addWidget(access, 3);

    auto *appearance = new QHBoxLayout;
    appearance->setContentsMargins(24, 18, 24, 0);
    appearance->setSpacing(8);
    appearance->addStretch();
    if (languagePicker) {
        auto *language = iconButton("accessLanguage", navIcon(World), ui("Language"));
        connect(language, &QPushButton::clicked, this, [this] { if (!busy) chooseLanguage(); });
        appearance->addWidget(language);
    }
    appearance->addWidget(themeButton(true));
    if (showExit) {
        auto *exit = iconButton("accessExit", accessIcon(AccessSymbol::Exit), ui("Exit"));
        connect(exit, &QPushButton::clicked, this, &QWidget::close);
        appearance->addWidget(exit);
    }
    accessLayout->addLayout(appearance);

    auto *scroll = new QScrollArea;
    scroll->setObjectName("accessScroll");
    scroll->setWidgetResizable(true);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    scroll->setFrameShape(QFrame::NoFrame);
    accessLayout->addWidget(scroll, 1);

    auto *surface = new QWidget;
    surface->setObjectName("accessSurface");
    auto *center = column(surface, 0, 0);
    center->setContentsMargins(28, 18, 28, 34);
    center->addStretch(1);
    auto *row = new QHBoxLayout;
    auto *form = new QWidget;
    form->setMaximumWidth(460);
    row->addStretch(1);
    row->addWidget(form, 12);
    row->addStretch(1);
    center->addLayout(row);
    center->addStretch(1);

    auto *controls = column(form, 0, 12);
    controls->addWidget(label(title, "accessTitle", true));
    if (!description.isEmpty())
        controls->addWidget(label(description, "accessDescription", true));
    controls->addSpacing(8);
    scroll->setWidget(surface);

    const auto previous = accessPage;
    accessPage = screen;
    stages->addWidget(screen);
    stages->setCurrentWidget(screen);
    if (previous) {
        stages->removeWidget(previous);
        previous->deleteLater();
    }
    return controls;
}

void WalletWindow::startup()
{
    QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
    const auto saved = settings.value("language").toString();
    const auto language = walletLanguage(saved);
    if (!saved.isEmpty() && saved != language) settings.setValue("language", language);
    const bool existing = !walletFiles(data).isEmpty();
    setWalletLanguage(root, language);
    if (existing) {
        walletAccess("open", AccessRoute::Startup);
    } else if (!saved.isEmpty()) {
        chooseWalletAction();
    } else {
        chooseLanguage();
    }
}

void WalletWindow::chooseLanguage()
{
    auto *form = accessPanel(ui("Language"), {}, false, true);
    auto *languages = new AnimatedCombo;
    languages->setObjectName("accessValue");
    fillLanguages(languages, false);
    QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
    const auto saved = languages->findData(settings.value("language"));
    if (saved >= 0) languages->setCurrentIndex(saved);
    field(form, ui("Interface language"), languages);
    auto *continueSetup = button(ui("Continue"), true);
    auto *back = walletFiles(data).isEmpty() ? nullptr : button(ui("Back"));
    connect(continueSetup, &QPushButton::clicked, this, [this, languages] {
        const auto selected = languages->currentData().toString();
        QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
        settings.setValue("language", selected);
        setWalletLanguage(root, selected);
        if (walletFiles(data).isEmpty()) chooseWalletAction();
        else walletAccess("open", AccessRoute::Startup);
    });
    if (back) connect(back, &QPushButton::clicked, this, [this] { walletAccess("open", AccessRoute::Startup); });
    accessActions(form, continueSetup, back);
    languages->setFocus();
}

void WalletWindow::chooseWalletAction()
{
    const bool atStartup = !workspace;
    const bool existing = !walletFiles(data).isEmpty();
    const auto description = existing ? ui("Create a wallet, open an existing one, or restore it from a recovery phrase.")
                                     : ui("Create a wallet or restore it from a recovery phrase.");
    auto *form = accessPanel(ui("Wallet setup"), description, atStartup, true);
    auto *create = button(ui("Create wallet"), true);
    auto *restore = button(ui("Restore wallet"));
    connect(create, &QPushButton::clicked, this, [this] { walletAccess("create", AccessRoute::Setup); });
    connect(restore, &QPushButton::clicked, this, [this] { walletAccess("restore", AccessRoute::Setup); });
    accessActions(form, create, nullptr, true);
    QList<QPushButton *> secondary{restore};
    if (existing) {
        auto *open = button(ui("Open wallet"));
        connect(open, &QPushButton::clicked, this, [this] { walletAccess("open", AccessRoute::Setup); });
        secondary.append(open);
    }

    accessAlternatives(form, secondary);
    create->setFocus();
}

void WalletWindow::walletAccess(const QString &mode, AccessRoute route, const QString &target)
{
    const bool switching = route == AccessRoute::Switch;
    if (closing || (switching ? activeWallet.isEmpty() || target == activeWallet : busy || !activeWallet.isEmpty())) return;
    const bool atStartup = route == AccessRoute::Startup;
    const bool unlocking = mode == "open";
    const bool restoring = mode == "restore";
    const auto names = unlocking && !switching ? walletFiles(data) : QStringList{};
    if (unlocking && !switching && names.isEmpty()) {
        chooseWalletAction();
        return;
    }
    const auto title = unlocking ? ui("Unlock wallet")
        : restoring ? ui("Restore wallet") : ui("Create wallet");
    const auto description = switching ? target : unlocking ? ui("Choose a wallet and enter its password.") : QString{};
    const bool outsideWorkspace = route == AccessRoute::Startup || route == AccessRoute::Setup;
    auto *form = accessPanel(title, description, outsideWorkspace, outsideWorkspace);
    auto *panel = new QWidget;
    auto *fields = column(panel, 0, 7);
    form->addWidget(panel);

    auto *name = new QLineEdit(panel);
    name->setObjectName("accessValue");
    auto *existing = new AnimatedCombo(panel);
    existing->setObjectName("accessValue");
    if (switching) {
        name->hide();
        existing->hide();
    } else if (unlocking) {
        name->hide();
        existing->addItems(names);
        QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
        const auto last = names.indexOf(settings.value("lastWallet").toString());
        if (last >= 0) existing->setCurrentIndex(last);
        field(fields, ui("Wallet on this computer"), existing);
    } else {
        existing->hide();
        name->setPlaceholderText(ui("Wallet filename"));
        field(fields, ui("Wallet name"), name);
    }

    auto *words = textBox(ui("Recovery phrase"));
    words->setParent(panel);
    auto *height = new QLineEdit(panel);
    height->setObjectName("accessValue");
    auto *seedLanguage = new AnimatedCombo(panel);
    seedLanguage->setObjectName("accessValue");
    if (restoring) {
        words->setPlaceholderText(ui("Enter the words in their original order"));
        field(fields, ui("Recovery phrase"), words);
        height->setPlaceholderText("0");
        height->setInputMethodHints(Qt::ImhDigitsOnly);
        field(fields, ui("Restore height"), height);
        fields->addWidget(label(ui("Choose a block at or before the first incoming transfer. Use 0 if the height is unknown."), "muted", true));
        seedLanguage->hide();
    } else {
        words->hide();
        height->hide();
        if (unlocking) seedLanguage->hide();
        else {
            fillLanguages(seedLanguage, true);
            field(fields, ui("Recovery phrase language"), seedLanguage);
        }
    }

    auto *password = new QLineEdit(panel);
    password->setObjectName("accessValue");
    password->setEchoMode(QLineEdit::Password);
    password->setPlaceholderText(unlocking ? ui("Enter password") : ui("Optional"));
    auto *repeat = new QLineEdit(panel);
    repeat->setObjectName("accessValue");
    repeat->setEchoMode(QLineEdit::Password);
    if (unlocking) {
        field(fields, ui("Password"), password);
        repeat->hide();
    } else {
        auto *credentials = new QHBoxLayout;
        credentials->setSpacing(10);
        auto *first = new QVBoxLayout;
        auto *second = new QVBoxLayout;
        first->setSpacing(7);
        second->setSpacing(7);
        field(first, ui("Password"), password);
        field(second, ui("Confirm password"), repeat);
        credentials->addLayout(first, 1);
        credentials->addLayout(second, 1);
        fields->addLayout(credentials);
    }

    auto *waiting = label(ui("Opening wallet…"), "muted", true);
    waiting->hide();
    form->addWidget(waiting);

    auto *submit = button(unlocking ? ui("Open") : restoring ? ui("Restore") : ui("Create"), true);
    QPushButton *back = nullptr;
    if (!(atStartup && unlocking)) {
        back = button(route == AccessRoute::Workspace || switching ? ui("Cancel") : ui("Back"));
        connect(back, &QPushButton::clicked, this, [this, route] {
            if (busy) return;
            if (route == AccessRoute::Switch) openWorkspace(Page(pages->currentIndex()));
            else if (route == AccessRoute::Workspace) openWorkspace(Wallets);
            else if (route == AccessRoute::Setup || walletFiles(data).isEmpty()) chooseWalletAction();
            else walletAccess("open", AccessRoute::Startup);
        });
        if (switching) {
            auto *escape = new QShortcut(QKeySequence(Qt::Key_Escape), accessPage);
            escape->setContext(Qt::WidgetWithChildrenShortcut);
            connect(escape, &QShortcut::activated, back, &QPushButton::click);
        }
    }
    auto *actionPanel = new QWidget;
    auto *actions = column(actionPanel, 0, 12);
    form->addWidget(actionPanel);
    accessActions(actions, submit, back, unlocking);
    if (atStartup && unlocking) {
        auto *create = button(ui("Create wallet"));
        auto *restore = button(ui("Restore wallet"));
        connect(create, &QPushButton::clicked, this, [this] { walletAccess("create", AccessRoute::Startup); });
        connect(restore, &QPushButton::clicked, this, [this] { walletAccess("restore", AccessRoute::Startup); });
        accessAlternatives(actions, {create, restore});
    }
    const auto setWorking = [panel, actionPanel, waiting](bool working) {
        panel->setEnabled(!working);
        actionPanel->setEnabled(!working);
        waiting->setVisible(working);
    };

    connect(submit, &QPushButton::clicked, accessPage,
            [this, mode, unlocking, restoring, switching, target, existing, name, password, repeat, words, height, seedLanguage, setWorking] {
        if (busy) return;
        const auto selected = switching ? target : unlocking ? existing->currentText() : name->text().trimmed();
        const auto credentials = password->text();
        const auto seed = words->toPlainText().simplified();
        const auto heightText = height->text().trimmed();
        bool validHeight = heightText.isEmpty();
        const auto fromHeight = heightText.isEmpty() ? qint64{0} : heightText.toLongLong(&validHeight);
        QString problem;
        if (selected.isEmpty()) problem = ui("Enter a wallet name.");
        else if (!unlocking && credentials != repeat->text()) problem = ui("The passwords do not match.");
        else if (restoring && seed.isEmpty()) problem = ui("Enter your recovery phrase.");
        else if (restoring && (!validHeight || fromHeight < 0)) problem = ui("Restore height must be a whole number of 0 or greater.");
        if (!problem.isEmpty()) {
            alert(ui("Check the wallet details"), problem);
            return;
        }

        setWorking(true);
        const auto language = seedLanguage->currentData().toString();
        const QPointer<QWidget> screen = accessPage;
        transact({}, [selected, credentials, mode, seed, fromHeight, language, switching](WalletService &wallet) {
            try {
                return wallet.open(selected, credentials, mode, seed, fromHeight,
                                   language.isEmpty() ? QString("English") : language);
            } catch (const std::exception &error) {
                if (!switching || wallet.isOpen()) throw;
                return QJsonObject{{"accessError", QString::fromUtf8(error.what())}};
            }
        }, [this, screen, selected, mode, password, repeat, words](const QJsonValue &state) {
            if (!screen) return;
            const auto error = state["accessError"].toString();
            if (!error.isEmpty()) {
                updateState({});
                walletAccess("open", AccessRoute::Startup);
                alert(ui("Action failed"), error);
                return;
            }
            QSettings settings(data + "/wallet.ini", QSettings::IniFormat);
            settings.setValue("lastWallet", selected);
            password->clear();
            repeat->clear();
            words->clear();
            if (mode == "create") showInitialBackup(state.toObject());
            else openWorkspace(Overview, state.toObject());
        }, false, [this, screen, unlocking, password, setWorking](const QString &failure) {
            if (!screen) return;
            setWorking(false);
            const bool invalid = unlocking && failure.contains("password", Qt::CaseInsensitive);
            alert(ui("Action failed"), invalid ? ui("Incorrect password. Try again.") : failure);
            if (invalid) {
                password->clear();
                password->setFocus();
            }
        });
    });
    connect(password, &QLineEdit::returnPressed, submit, &QPushButton::click);
    connect(repeat, &QLineEdit::returnPressed, submit, &QPushButton::click);
    if (unlocking) password->setFocus();
    else name->setFocus();
}

void WalletWindow::showInitialBackup(const QJsonObject &state)
{
    auto *form = accessPanel(ui("Save your recovery phrase"),
                             ui("This phrase gives access to the funds. Store it separately from the wallet."));
    auto *words = textBox(ui("Recovery phrase"), true);
    words->setFixedHeight(116);
    form->addWidget(words);
    auto *message = label({}, "muted", true);
    form->addWidget(message);
    auto *retry = button(ui("Retry"));
    retry->hide();
    auto *finish = button(ui("I saved the phrase"), true);
    finish->setEnabled(false);
    connect(finish, &QPushButton::clicked, this, [this, state, words] {
        words->clear();
        openWorkspace(Overview, state);
    });
    accessActions(form, finish, retry);

    const QPointer<QWidget> screen = accessPage;
    const auto read = [this, screen, words, message, retry, finish] {
        retry->hide();
        message->setText(ui("Reading recovery phrase") + "…");
        message->show();
        transact({}, [](WalletService &wallet) { return QJsonValue(wallet.seed()); },
                 [screen, words, message, finish](const QJsonValue &seed) {
            if (!screen) return;
            words->setPlainText(seed.toString());
            message->hide();
            finish->setEnabled(true);
            finish->setFocus();
        }, false, [this, screen, message, retry](const QString &failure) {
            if (!screen) return;
            message->hide();
            retry->show();
            alert(ui("Action failed"), failure);
        });
    };
    connect(retry, &QPushButton::clicked, accessPage, read);
    read();
}

void WalletWindow::showSeed()
{
    transact(ui("Reading recovery phrase"), [](WalletService &wallet) { return QJsonValue(wallet.seed()); },
             [this](const QJsonValue &seed) {
        QDialog dialog(this);
        dialog.setWindowTitle(ui("Recovery phrase"));
        dialog.setMinimumWidth(510);
        auto *form = column(&dialog, 22);
        form->addWidget(label(ui("Save your recovery phrase"), "heading"));
        form->addWidget(label(ui("This phrase gives access to the funds. Store it separately from the wallet."), "muted", true));
        auto *words = textBox(ui("Recovery phrase"), true);
        words->setPlainText(seed.toString());
        form->addWidget(words);
        auto *done = button(ui("Done"), true);
        connect(done, &QPushButton::clicked, &dialog, &QDialog::accept);
        dialogButtons(form, {done});
        dialog.exec();
    });
}

void WalletWindow::setMaximum(bool enabled)
{
    maximum = enabled;
    maxButton->setChecked(enabled);
    maxHint->setVisible(enabled);
    if (enabled) {
        amount->setText(spendable);
        scheduleMaximumQuote();
    } else {
        ++maximumQuoteVersion;
        maximumQuoteTimer->stop();
        feeQuote->setText(ui("The fee and total appear when you review the transfer."));
    }
}

void WalletWindow::showAddressBook()
{
    transact(ui("Loading address book"), [](WalletService &wallet) { return wallet.addressBook(); },
             [this](const QJsonValue &value) {
        QDialog dialog(this);
        dialog.setObjectName("addressBook");
        dialog.setWindowTitle(ui("Address book"));
        dialog.setMinimumWidth(565);
        auto *form = column(&dialog, 20, 10);
        form->addWidget(label(ui("Address book"), "heading"));
        auto *table = readOnlyTable({ui("Contact name"), ui("Address")});
        table->setObjectName("addressBookTable");
        table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
        table->setMinimumHeight(148);
        auto *empty = label(ui("No addresses saved yet."), "muted", true);
        form->addWidget(table);
        form->addWidget(empty);

        auto *editor = new QFrame;
        editor->setObjectName("inset");
        auto *fields = column(editor, 14, 7);
        auto *description = new QLineEdit;
        description->setMaxLength(64);
        auto *recipient = addressBox(ui("Recipient address"));
        recipient->setFixedHeight(64);
        recipient->setPlainText(toAddress->toPlainText().trimmed());
        field(fields, ui("Contact name"), description);
        field(fields, ui("Recipient address"), recipient);
        auto *status = label({}, "muted", true);
        status->hide();
        fields->addWidget(status);
        auto *save = button(ui("Save address"));
        buttons(fields, {save});
        form->addWidget(editor);

        auto *use = button(ui("Use address"), true);
        auto *done = button(ui("Close"));
        use->setEnabled(false);
        const auto populate = [table, empty, use](const QJsonArray &contacts) {
            table->setRowCount(contacts.size());
            table->clearSelection();
            table->setCurrentItem(nullptr);
            use->setEnabled(false);
            int row = 0;
            for (const auto &entry : contacts) {
                const auto contact = entry.toObject();
                const auto address = contact["address"].toString();
                auto *name = new QTableWidgetItem(contact["description"].toString());
                auto *cell = new QTableWidgetItem(address);
                cell->setToolTip(address);
                table->setItem(row, 0, name);
                table->setItem(row++, 1, cell);
            }
            table->setVisible(!contacts.isEmpty());
            empty->setVisible(contacts.isEmpty());
        };
        populate(value.toArray());
        connect(table, &QTableWidget::currentCellChanged, &dialog, [use](int row) { use->setEnabled(row >= 0); });
        connect(use, &QPushButton::clicked, &dialog, [this, &dialog, table] {
            if (const auto *cell = table->item(table->currentRow(), 1)) {
                toAddress->setPlainText(cell->text());
                dialog.accept();
            }
        });
        connect(table, &QTableWidget::cellDoubleClicked, use, &QPushButton::click);
        connect(done, &QPushButton::clicked, &dialog, &QDialog::reject);
        connect(save, &QPushButton::clicked, &dialog, [this, &dialog, save, recipient, description, status, populate] {
            if (busy) return;
            const auto address = recipient->toPlainText().simplified().remove(' ');
            if (address.isEmpty()) {
                status->setText(ui("Paste the recipient address."));
                status->show();
                recipient->setFocus();
                return;
            }
            const auto name = description->text().trimmed();
            const QPointer<QDialog> window(&dialog);
            save->setEnabled(false);
            status->hide();
            transact({}, [address, name](WalletService &wallet) { return wallet.saveContact(address, name); },
                     [window, save, populate, status](const QJsonValue &book) {
                if (!window) return;
                populate(book.toArray());
                save->setEnabled(true);
                status->setText(ui("Address saved"));
                status->show();
            }, false, [window, save, status](const QString &error) {
                if (!window) return;
                save->setEnabled(true);
                status->setText(error);
                status->show();
            });
        });
        dialogButtons(form, {done, use});
        done->setDefault(true);
        dialog.exec();
    });
}

void WalletWindow::showPeers()
{
    transact(ui("Loading peers"), [](WalletService &wallet) { return wallet.networkPeers(); },
             [this](const QJsonValue &value) {
        const auto data = value.toObject();
        QDialog dialog(this);
        dialog.setObjectName("peerList");
        dialog.setWindowTitle(ui("Network peers"));
        dialog.setMinimumWidth(630);
        auto *form = column(&dialog, 20, 12);
        const auto addSection = [form](const QString &name, const QString &detail, const QStringList &headers,
                                       const QList<QStringList> &rows) {
            auto *panel = new QFrame;
            panel->setObjectName("inset");
            auto *layout = column(panel, 13, 7);
            layout->addWidget(label(name, "heading", true));
            if (!detail.isEmpty()) layout->addWidget(label(detail, "muted", true));
            if (!rows.isEmpty()) {
                auto *table = readOnlyTable(headers);
                for (int i = 1; i < headers.size(); ++i)
                    table->horizontalHeader()->setSectionResizeMode(i, QHeaderView::ResizeToContents);
                table->setRowCount(rows.size());
                table->setFixedHeight(table->horizontalHeader()->height() + qMin<qsizetype>(rows.size(), 5) * 34 + 6);
                for (int y = 0; y < rows.size(); ++y) {
                    const auto &values = rows[y];
                    for (int x = 0; x < values.size(); ++x) {
                        auto *item = new QTableWidgetItem(values[x]);
                        item->setToolTip(values[x]);
                        table->setItem(y, x, item);
                    }
                }
                layout->addWidget(table);
            }
            form->addWidget(panel);
        };
        QList<QStringList> connections;
        for (const auto &entry : data["connections"].toArray()) {
            const auto peer = entry.toObject();
            connections.append({peer["address"].toString(), ui(peer["incoming"].toBool() ? "Incoming" : "Outgoing"),
                peer["height"].toString(), peer["peer"].toString()});
        }
        addSection(ui("Connected peers"), connections.isEmpty() ? ui("No connected peers.") : QString{},
                   {ui("Address"), ui("Direction"), ui("Blockchain height"), ui("Peer ID")}, connections);
        QList<QStringList> operators;
        for (const auto &entry : data["operators"].toArray()) {
            const auto peer = entry.toObject();
            const auto identity = peer["identity"].toString();
            operators.append({peer["endpoint"].toString(), identity.left(16), peer["expires"].toString()});
        }
        const auto detail = data["operatorRosterUnavailable"].toBool() ? ui("The note operator registry is unavailable.")
            : operators.isEmpty() ? ui("No note operators are registered.")
            : ui("Registered operators. %1 required for note delivery.").arg(data["threshold"].toInt());
        addSection(ui("Note operators"), detail, {ui("Endpoint"), ui("Operator ID"), ui("Expires at block")}, operators);
        auto *done = button(ui("Close"), true);
        connect(done, &QPushButton::clicked, &dialog, &QDialog::accept);
        dialogButtons(form, {done});
        dialog.exec();
    });
}

void WalletWindow::scheduleMaximumQuote()
{
    if (!maximum) {
        if (feeQuote) feeQuote->setText(ui("The fee and total appear when you review the transfer."));
        return;
    }
    ++maximumQuoteVersion;
    maxHint->setText(ui("Calculating the maximum after the fee…"));
    feeQuote->setText(ui("Calculating fee") + "…");
    maximumQuoteTimer->start();
}

void WalletWindow::quoteMaximum()
{
    if (!maximum || closing || activeWallet.isEmpty() || stages->currentWidget() != workspace
        || pages->currentIndex() != Send || QApplication::activeModalWidget()) return;
    if (busy) {
        maximumQuoteTimer->start();
        return;
    }
    const auto request = maximumQuoteVersion;
    const int priority = feePriority->currentData().toInt();
    transact({}, [priority](WalletService &wallet) { return wallet.estimateMaximum(priority); },
             [this, request](const QJsonValue &quote) {
        if (request != maximumQuoteVersion || !maximum) return;
        amount->setText(quote["amount"].toString());
        maxHint->setText(ui("Exact amount and fee at review."));
        feeQuote->setText(ui("Estimated fee") + " · " + quote["fee"].toString() + " Noticoin");
    }, false, [this, request](const QString &error) {
        if (request != maximumQuoteVersion || !maximum) return;
        maxHint->setText(ui("The maximum will be recalculated when you review the transfer."));
        feeQuote->setText(error);
    });
}

void WalletWindow::send()
{
    if (activeWallet.isEmpty() || busy) return;
    const auto recipient = toAddress->toPlainText().simplified().remove(' ');
    const auto coins = amount->text();
    const bool sendAll = maximum;
    try {
        if (recipient.isEmpty()) throw Error(ui("Paste the recipient address."));
        if (!sendAll) parseMoney(coins);
    } catch (const std::exception &error) {
        alert(ui("Review transfer"), QString::fromUtf8(error.what()));
        (recipient.isEmpty() ? static_cast<QWidget *>(toAddress) : amount)->setFocus();
        return;
    }
    maximumQuoteTimer->stop();
    reviewTransfer(recipient, coins, sendAll);
}

void WalletWindow::reviewTransfer(const QString &recipient, const QString &coins, bool sendAll,
                                  bool fromMap, const QString &invoiceId, const QString &mapRecord, TransferPurpose purpose)
{
    const int priority = fromMap ? 1 : feePriority->currentData().toInt();
    transact(ui(sendAll ? "Preparing maximum transfer" : "Calculating fee"), [recipient, coins, sendAll, mapRecord, purpose, priority](WalletService &wallet) {
        return wallet.prepare(recipient, coins, sendAll, mapRecord, purpose, priority);
    },
             [this, sendAll, fromMap, invoiceId, priority, purpose, feeOnly = !mapRecord.isEmpty() && recipient == publicAddress](const QJsonValue &value) {
        const auto tx = value.toObject();
        const bool donation = purpose == TransferPurpose::MapDonation;
        if (!fromMap) {
            maximumQuoteTimer->stop();
            feeQuote->setText(ui("Fee") + " · " + tx["fee"].toString() + " Noticoin");
            if (sendAll && maximum) {
                amount->setText(tx["amount"].toString());
                maxHint->setText(ui("All spendable funds minus fees"));
            }
        }
        QDialog dialog(this);
        dialog.setObjectName("transferConfirmation");
        dialog.setWindowTitle(donation ? ui("Confirm donation") : fromMap ? ui("Confirm map payment") : ui("Confirm transfer"));
        dialog.setMinimumWidth(500);
        auto *form = column(&dialog, 22);
        form->addWidget(label(donation ? ui("Confirm donation") : fromMap ? ui("Confirm map payment") : ui("Review transfer"), "heading"));
        auto *target = addressBox(ui("Recipient address"), true);
        target->setPlainText(tx["recipient"].toString());
        field(form, ui("Recipient address"), target);
        auto *summary = new QFrame;
        summary->setObjectName("inset");
        auto *totals = new QGridLayout(summary);
        totals->setContentsMargins(15, 13, 15, 13);
        totals->setVerticalSpacing(8);
        totals->setColumnStretch(0, 1);
        totals->addWidget(label(ui("Amount"), "field"), 0, 0);
        totals->addWidget(label(tx["amount"].toString() + " Noticoin"), 0, 1, Qt::AlignRight);
        totals->addWidget(label(ui("Fee") + " · " + ui(feePriorities.at(priority - 1)), "field"), 1, 0);
        totals->addWidget(label(tx["fee"].toString() + " Noticoin"), 1, 1, Qt::AlignRight);
        totals->addWidget(label(ui("Total"), "field"), 2, 0);
        totals->addWidget(label(tx["total"].toString() + " Noticoin", "heading"), 2, 1, Qt::AlignRight);
        form->addWidget(summary);
        if (feeOnly) form->addWidget(label(ui("The amount returns to your wallet. Only the network fee is charged."), "muted", true));
        if (sendAll) form->addWidget(label(ui("All spendable funds minus fees"), "muted", true));
        if (tx["transactions"].toInt() > 1)
            form->addWidget(label(ui("Transactions: %1").arg(tx["transactions"].toInt()), "muted", true));
        auto *approve = button(fromMap && !donation ? ui("Pay") : ui("Send"), true);
        auto *cancel = button(ui("Cancel"));
        approve->setAutoDefault(false);
        cancel->setDefault(true);
        connect(approve, &QPushButton::clicked, &dialog, &QDialog::accept);
        connect(cancel, &QPushButton::clicked, &dialog, &QDialog::reject);
        dialogButtons(form, {cancel, approve});
        cancel->setFocus();
        QPropertyAnimation appear(&dialog, "windowOpacity");
        if (clientAnimationsEnabled()) {
            dialog.setWindowOpacity(0.0);
            appear.setDuration(160);
            appear.setEasingCurve(QEasingCurve::OutCubic);
            appear.setStartValue(0.0);
            appear.setEndValue(1.0);
            appear.start();
        }
        timer->stop();
        const auto decision = dialog.exec();
        timer->start();
        if (decision != QDialog::Accepted) {
            transact({}, [](WalletService &wallet) { wallet.discard(); return QJsonValue(); });
            return;
        }
        transact(ui("Sending transfer"), [](WalletService &wallet) { return QJsonValue(wallet.relay()); },
                 [this, fromMap, invoiceId, donation, sentAmount = tx["amount"].toString()](const QJsonValue &value) {
            const auto result = value.toObject();
            QStringList hashes;
            for (const auto &id : result["ids"].toArray()) hashes << id.toString();
            const auto failure = result["error"].toString();
            if (!hashes.isEmpty()) {
                if (fromMap) {
                    if (map && !invoiceId.isEmpty()) map->paymentSubmitted(invoiceId, hashes.first());
                } else {
                    setMaximum(false);
                    amount->clear();
                    toAddress->clear();
                    showPage(History);
                }
            }
            if (failure.isEmpty()) {
                if (donation && !hashes.isEmpty()) {
                    if (map && pages->currentIndex() == World) map->donationSent(sentAmount);
                    else notify(ui("Donation sent: %1 Noticoin").arg(sentAmount), 5000);
                } else if (!fromMap || invoiceId.isEmpty()) notify(ui("Transfer sent"), 5000);
            } else {
                const auto title = hashes.isEmpty() ? (fromMap ? ui("Could not send map payment") : ui("Could not confirm that the transfer was sent.")) : ui("Transfer partially sent");
                const auto sent = hashes.isEmpty() ? QString() : "\n\n" + ui("Transaction ID:\n") + hashes.join('\n');
                alert(title, failure + sent);
                if (hashes.isEmpty()) refresh();
            }
        });
    }, true, [this, fromMap](const QString &failure) {
        alert(fromMap ? ui("Could not send map payment") : ui("Action failed"), failure);
    });
}

void WalletWindow::invoice(const QUrl &url)
{
    if (busy || closing || activeWallet.isEmpty() || stages->currentWidget() != workspace
        || pages->currentIndex() != World || QApplication::activeModalWidget()) return;
    const QUrlQuery query(url);
    const auto record = query.queryItemValue("map_record");
    static const QRegularExpression recordFormat(R"(^4e544d50010[12][a-f0-9]{224}$)");
    if (!record.isEmpty() && !recordFormat.match(record).hasMatch()) return;
    const bool toSelf = url.path() == "self" && !record.isEmpty();
    const auto recipient = toSelf ? publicAddress : url.path();
    static const QRegularExpression address(R"(^[1-9A-HJ-NP-Za-km-z]{95,106}$)");
    if (!address.match(recipient).hasMatch()) return;
    const bool donation = query.queryItemValue("donate") == "1";
    auto coins = toSelf ? QString("0.000000001") : query.queryItemValue("tx_amount");
    const auto id = query.queryItemValue("map_invoice");
    static const QRegularExpression invoiceId(R"(^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$)");
    if (!id.isEmpty() && !invoiceId.match(id).hasMatch()) return;
    const bool purchase = !id.isEmpty() && record.isEmpty() && query.queryItemValue("map_purchase") == "1";
    const auto purpose = donation ? TransferPurpose::MapDonation : purchase ? TransferPurpose::MapPurchase : TransferPurpose::Regular;
    if (donation && coins.isEmpty()) {
        bool entered = false;
        coins = QInputDialog::getText(this, ui("Enter a donation amount."), ui("Amount in Noticoin"),
                                      QLineEdit::Normal, {}, &entered);
        if (!entered) return;
    }
    try { parseMoney(coins); }
    catch (const std::exception &error) {
        alert(ui("Confirm map payment"), QString::fromUtf8(error.what()));
        return;
    }
    reviewTransfer(recipient, coins, false, true, id, record, purpose);
}

void WalletWindow::closeEvent(QCloseEvent *event)
{
    if (closeReady) { event->accept(); return; }
    event->ignore();
    if (busy || closing) return;
    closing = true;
    timer->stop();
    transact(ui("Saving wallet"), [this](WalletService &wallet) {
        try { wallet.shutdown(); }
        catch (...) {
            QMetaObject::invokeMethod(this, [this] { closing = false; timer->start(); }, Qt::QueuedConnection);
            throw;
        }
        return QJsonValue();
    }, [this](QJsonValue) { closeReady = true; close(); });
}
}
