#include "app/single_instance_ipc.hpp"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QLockFile>
#include <QLocalSocket>
#include <QStandardPaths>
#include <QStringConverter>
#include <QTimer>
#include <QtEndian>

#include <algorithm>
#include <utility>

namespace patchy::app {
namespace {

constexpr char kMagic[] = {'P', 'T', 'S', 'I'};
constexpr quint16 kProtocolVersion = 1;
const QString kCommandPrefix = QStringLiteral("patchy-cmd:");
const QString kScreenshotCommandPrefix = QStringLiteral("patchy-cmd:screenshot\n");
const QString kRunScriptCommandPrefix = QStringLiteral("patchy-cmd:run-script\n");

void append_u16(QByteArray& bytes, quint16 value) {
  char encoded[sizeof(value)];
  qToBigEndian<quint16>(value, reinterpret_cast<uchar*>(encoded));
  bytes.append(encoded, sizeof(encoded));
}

void append_u32(QByteArray& bytes, quint32 value) {
  char encoded[sizeof(value)];
  qToBigEndian<quint32>(value, reinterpret_cast<uchar*>(encoded));
  bytes.append(encoded, sizeof(encoded));
}

quint16 read_u16(const char* bytes) {
  return qFromBigEndian<quint16>(reinterpret_cast<const uchar*>(bytes));
}

quint32 read_u32(const char* bytes) {
  return qFromBigEndian<quint32>(reinterpret_cast<const uchar*>(bytes));
}

bool valid_absolute_path(const QString& path) {
  return !path.isEmpty() && !path.contains(QLatin1Char('\n')) &&
         !path.contains(QChar::Null) && QFileInfo(path).isAbsolute();
}

bool valid_screenshot_region(const QString& region) {
  if (region.isEmpty()) {
    return true;
  }
  const auto parts = region.split(QLatin1Char(','));
  if (parts.size() != 4) {
    return false;
  }
  int values[4] = {};
  for (int index = 0; index < 4; ++index) {
    bool ok = false;
    values[index] = parts[index].trimmed().toInt(&ok);
    if (!ok) {
      return false;
    }
  }
  return values[2] > 0 && values[3] > 0;
}

bool validate_entries(const QStringList& entries, QString* error) {
  if (entries.size() > kSingleInstanceMaxEntries) {
    if (error != nullptr) {
      *error = QStringLiteral("too many request entries");
    }
    return false;
  }
  for (const auto& entry : entries) {
    if (entry.isEmpty() || entry.contains(QChar::Null)) {
      if (error != nullptr) {
        *error = QStringLiteral("empty or NUL-containing request entry");
      }
      return false;
    }
    if (entry.startsWith(kScreenshotCommandPrefix)) {
      if (!decode_screenshot_command(entry).has_value()) {
        if (error != nullptr) {
          *error = QStringLiteral("malformed screenshot command");
        }
        return false;
      }
      continue;
    }
    if (entry.startsWith(kRunScriptCommandPrefix)) {
      if (!decode_run_script_command(entry).has_value()) {
        if (error != nullptr) {
          *error = QStringLiteral("malformed run-script command");
        }
        return false;
      }
      continue;
    }
    if (entry.startsWith(kCommandPrefix) || !valid_absolute_path(entry)) {
      if (error != nullptr) {
        *error = QStringLiteral("invalid file entry or unknown command");
      }
      return false;
    }
  }
  return true;
}

SingleInstanceDecodeResult rejected(QString error) {
  return {SingleInstanceDecodeState::Rejected, {}, std::move(error)};
}

QString private_runtime_directory() {
#ifdef Q_OS_WIN
  auto runtime = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
#else
  auto runtime = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
#endif
#ifdef Q_OS_LINUX
  const auto flatpak_id = qEnvironmentVariable("FLATPAK_ID");
  if (!flatpak_id.isEmpty()) {
    runtime += QStringLiteral("/app/") + flatpak_id;
  }
#endif
  if (runtime.isEmpty()) {
    return {};
  }
  const auto directory = QDir(runtime).filePath(QStringLiteral("patchy-ipc"));
  if (!QDir().mkpath(directory) ||
#ifdef Q_OS_WIN
      false) {
#else
      !QFile::setPermissions(directory, QFileDevice::ReadOwner | QFileDevice::WriteOwner |
                                           QFileDevice::ExeOwner)) {
#endif
    return {};
  }
  const QFileInfo info(directory);
#ifdef Q_OS_WIN
  if (!info.isDir() || info.isSymLink()) {
    return {};
  }
#else
  const auto forbidden = QFileDevice::ReadGroup | QFileDevice::WriteGroup |
                         QFileDevice::ExeGroup | QFileDevice::ReadOther |
                         QFileDevice::WriteOther | QFileDevice::ExeOther;
  if (!info.isDir() || info.isSymLink() || (info.permissions() & forbidden) != 0) {
    return {};
  }
#endif
  return info.canonicalFilePath();
}

QString lock_path_for_endpoint(const QString& endpoint) {
  const auto directory = private_runtime_directory();
  if (directory.isEmpty()) {
    return {};
  }
  const auto digest = QCryptographicHash::hash(endpoint.toUtf8(), QCryptographicHash::Sha256)
                          .toHex()
                          .left(32);
  return QDir(directory).filePath(QStringLiteral("listener-") +
                                  QString::fromLatin1(digest) + QStringLiteral(".lock"));
}

}  // namespace

QString single_instance_endpoint_for_identity(const QString& home_path,
                                              const QString& installation_path) {
  auto installation = QDir(installation_path).canonicalPath();
  if (installation.isEmpty()) {
    installation = QDir(installation_path).absolutePath();
  }
#ifdef Q_OS_WIN
  installation = installation.toLower();
#endif
  const auto identity = (QStringLiteral("patchy-single-instance-v1\n") +
                         QDir(home_path).absolutePath() + QLatin1Char('\n') + installation)
                            .toUtf8();
  const auto digest = QCryptographicHash::hash(identity, QCryptographicHash::Sha256)
                          .toHex()
                          .left(32);
  return QStringLiteral("PatchyInstance-") + QString::fromLatin1(digest);
}

QString single_instance_endpoint() {
  const auto name = single_instance_endpoint_for_identity(
      QDir::homePath(), QCoreApplication::applicationDirPath());
#ifdef Q_OS_WIN
  // Windows named-pipe ACLs honor UserAccessOption directly.
  return name;
#else
  // macOS ignores Unix-socket file permissions. Put the socket behind an
  // owner-only directory so path traversal itself is OS-enforced there; Linux
  // receives the same defence in depth in addition to UserAccessOption.
  const auto directory = private_runtime_directory();
  if (directory.isEmpty()) {
    return {};
  }
  return QDir(directory).filePath(name);
#endif
}

QString make_screenshot_command(const QString& output_path, const QString& widget_name,
                                const QString& region) {
  return kScreenshotCommandPrefix + output_path + QLatin1Char('\n') + widget_name +
         QLatin1Char('\n') + region;
}

QString make_run_script_command(const QString& script_path, const QString& output_path,
                                const QStringList& arguments) {
  auto command = kRunScriptCommandPrefix + script_path + QLatin1Char('\n') + output_path;
  for (const auto& argument : arguments) {
    command += QLatin1Char('\n') + argument;
  }
  return command;
}

std::optional<ScreenshotCommand> decode_screenshot_command(const QString& entry) {
  if (!entry.startsWith(kScreenshotCommandPrefix)) {
    return std::nullopt;
  }
  const auto parts = entry.split(QLatin1Char('\n'));
  if (parts.size() != 4 || !valid_absolute_path(parts[1]) ||
      parts[2].contains(QChar::Null) || !valid_screenshot_region(parts[3])) {
    return std::nullopt;
  }
  return ScreenshotCommand{parts[1], parts[2], parts[3]};
}

std::optional<RunScriptCommand> decode_run_script_command(const QString& entry) {
  if (!entry.startsWith(kRunScriptCommandPrefix)) {
    return std::nullopt;
  }
  const auto parts = entry.split(QLatin1Char('\n'));
  if (parts.size() < 3 || !valid_absolute_path(parts[1]) ||
      (!parts[2].isEmpty() && !valid_absolute_path(parts[2]))) {
    return std::nullopt;
  }
  for (qsizetype index = 3; index < parts.size(); ++index) {
    if (parts[index].contains(QChar::Null)) {
      return std::nullopt;
    }
  }
  return RunScriptCommand{parts[1], parts[2], parts.mid(3)};
}

QByteArray encode_single_instance_frame(const QStringList& entries, QString* error) {
  QString validation_error;
  if (!validate_entries(entries, &validation_error)) {
    if (error != nullptr) {
      *error = validation_error;
    }
    return {};
  }

  QByteArray payload;
  payload.reserve(2 + entries.size() * 8);
  append_u16(payload, static_cast<quint16>(entries.size()));
  for (const auto& entry : entries) {
    const auto encoded = entry.toUtf8();
    QStringDecoder decoder(QStringDecoder::Utf8);
    if (encoded.size() > kSingleInstanceMaxEntryBytes || decoder.decode(encoded) != entry ||
        decoder.hasError()) {
      if (error != nullptr) {
        *error = QStringLiteral("request entry is too large or is not canonical UTF-8");
      }
      return {};
    }
    const qint64 next_size = static_cast<qint64>(payload.size()) + 4 + encoded.size();
    if (next_size > kSingleInstanceMaxPayloadBytes) {
      if (error != nullptr) {
        *error = QStringLiteral("request frame is too large");
      }
      return {};
    }
    append_u32(payload, static_cast<quint32>(encoded.size()));
    payload.append(encoded);
  }

  QByteArray frame;
  frame.reserve(kSingleInstanceHeaderBytes + payload.size());
  frame.append(kMagic, sizeof(kMagic));
  append_u16(frame, kProtocolVersion);
  append_u16(frame, 0);
  append_u32(frame, static_cast<quint32>(payload.size()));
  frame.append(payload);
  if (error != nullptr) {
    error->clear();
  }
  return frame;
}

SingleInstanceDecodeResult decode_single_instance_frame(const QByteArray& frame) {
  if (frame.size() > kSingleInstanceMaxFrameBytes) {
    return rejected(QStringLiteral("frame exceeds the maximum size"));
  }
  if (frame.size() < kSingleInstanceHeaderBytes) {
    return {};
  }
  if (!std::equal(std::begin(kMagic), std::end(kMagic), frame.constData())) {
    return rejected(QStringLiteral("wrong frame magic"));
  }
  if (read_u16(frame.constData() + 4) != kProtocolVersion) {
    return rejected(QStringLiteral("unsupported frame version"));
  }
  if (read_u16(frame.constData() + 6) != 0) {
    return rejected(QStringLiteral("non-zero reserved frame flags"));
  }
  const auto payload_size = read_u32(frame.constData() + 8);
  if (payload_size > static_cast<quint32>(kSingleInstanceMaxPayloadBytes)) {
    return rejected(QStringLiteral("declared payload exceeds the maximum size"));
  }
  const auto expected_size = kSingleInstanceHeaderBytes + static_cast<qsizetype>(payload_size);
  if (frame.size() < expected_size) {
    return {};
  }
  if (frame.size() != expected_size) {
    return rejected(QStringLiteral("trailing bytes after the declared payload"));
  }

  const char* cursor = frame.constData() + kSingleInstanceHeaderBytes;
  qsizetype remaining = payload_size;
  if (remaining < 2) {
    return rejected(QStringLiteral("payload has no request count"));
  }
  const auto count = read_u16(cursor);
  cursor += 2;
  remaining -= 2;
  if (count > kSingleInstanceMaxEntries) {
    return rejected(QStringLiteral("request entry count exceeds the maximum"));
  }

  QStringList entries;
  entries.reserve(count);
  for (quint16 index = 0; index < count; ++index) {
    if (remaining < 4) {
      return rejected(QStringLiteral("truncated request entry length"));
    }
    const auto entry_size = read_u32(cursor);
    cursor += 4;
    remaining -= 4;
    if (entry_size > static_cast<quint32>(kSingleInstanceMaxEntryBytes) ||
        entry_size > static_cast<quint32>(remaining)) {
      return rejected(QStringLiteral("invalid request entry length"));
    }
    const QByteArrayView encoded(cursor, entry_size);
    QStringDecoder decoder(QStringDecoder::Utf8);
    const QString entry = decoder.decode(encoded);
    if (decoder.hasError() || entry.toUtf8() != encoded) {
      return rejected(QStringLiteral("request entry is not canonical UTF-8"));
    }
    entries.append(entry);
    cursor += entry_size;
    remaining -= entry_size;
  }
  if (remaining != 0) {
    return rejected(QStringLiteral("payload contains trailing data"));
  }
  QString validation_error;
  if (!validate_entries(entries, &validation_error)) {
    return rejected(validation_error);
  }
  return {SingleInstanceDecodeState::Accepted, std::move(entries), {}};
}

QByteArray single_instance_acknowledgement() { return QByteArrayLiteral("PTSI-ACK-1\n"); }

bool forward_single_instance_request(const QStringList& entries, int timeout_ms) {
  return forward_single_instance_request_to(single_instance_endpoint(), entries, timeout_ms);
}

bool forward_single_instance_request_to(const QString& endpoint, const QStringList& entries,
                                        int timeout_ms) {
  if (endpoint.isEmpty()) {
    return false;
  }
  const auto frame = encode_single_instance_frame(entries);
  if (frame.isEmpty()) {
    return false;
  }
  QLocalSocket socket;
  socket.connectToServer(endpoint);
  if (!socket.waitForConnected(std::max(timeout_ms, 0))) {
    return false;
  }
  if (socket.write(frame) != frame.size() || !socket.waitForBytesWritten(std::max(timeout_ms, 0))) {
    socket.abort();
    return false;
  }

  const auto expected_ack = single_instance_acknowledgement();
  QByteArray ack;
  QElapsedTimer elapsed;
  elapsed.start();
  while (ack.size() < expected_ack.size()) {
    const int remaining = std::max(0, timeout_ms - static_cast<int>(elapsed.elapsed()));
    if (socket.bytesAvailable() == 0 && !socket.waitForReadyRead(remaining)) {
      socket.abort();
      return false;
    }
    ack.append(socket.read(expected_ack.size() - ack.size()));
  }
  if (ack != expected_ack || socket.bytesAvailable() != 0) {
    socket.abort();
    return false;
  }
  socket.disconnectFromServer();
  if (socket.state() != QLocalSocket::UnconnectedState) {
    (void)socket.waitForDisconnected(std::max(0, timeout_ms - static_cast<int>(elapsed.elapsed())));
  }
  return true;
}

struct SingleInstanceServer::Impl {
  explicit Impl(RequestHandler request_handler) : handler(std::move(request_handler)) {
    server.setSocketOptions(QLocalServer::UserAccessOption);
    QObject::connect(&server, &QLocalServer::newConnection, &server, [this] {
      while (server.hasPendingConnections()) {
        auto* client = server.nextPendingConnection();
        if (client == nullptr) {
          continue;
        }
        auto buffer = std::make_shared<QByteArray>();
        auto complete = std::make_shared<bool>(false);
        auto consume = [this, client, buffer, complete] {
          if (*complete) {
            return;
          }
          const auto room = kSingleInstanceMaxFrameBytes + 1 - buffer->size();
          if (room <= 0) {
            *complete = true;
            client->abort();
            return;
          }
          buffer->append(client->read(std::min(client->bytesAvailable(), room)));
          if (client->bytesAvailable() > 0) {
            *complete = true;
            client->abort();
            return;
          }
          auto decoded = decode_single_instance_frame(*buffer);
          if (decoded.state == SingleInstanceDecodeState::Incomplete) {
            return;
          }
          *complete = true;
          if (decoded.state == SingleInstanceDecodeState::Rejected) {
            client->abort();
            return;
          }
          const auto acknowledgement = single_instance_acknowledgement();
          if (client->write(acknowledgement) != acknowledgement.size()) {
            client->abort();
            return;
          }
          (void)client->flush();
          if (client->bytesToWrite() > 0 && !client->waitForBytesWritten(500)) {
            client->abort();
            return;
          }
          handler(std::move(decoded.entries));
          client->disconnectFromServer();
        };
        QObject::connect(client, &QLocalSocket::readyRead, client, consume);
        QObject::connect(client, &QLocalSocket::disconnected, client, [client] {
          client->deleteLater();
        });
        QTimer::singleShot(2000, client, [client, complete] {
          if (!*complete) {
            *complete = true;
            client->abort();
          }
        });
        if (client->bytesAvailable() > 0) {
          consume();
        }
      }
    });
  }

  RequestHandler handler;
  std::unique_ptr<QLockFile> lock;
  QLocalServer server;
};

SingleInstanceServer::SingleInstanceServer(RequestHandler handler)
    : impl_(std::make_unique<Impl>(std::move(handler))) {}

SingleInstanceServer::~SingleInstanceServer() = default;

bool SingleInstanceServer::listen(const QString& endpoint, QString* error) {
  if (endpoint.isEmpty()) {
    if (error != nullptr) {
      *error = QStringLiteral("private single-instance endpoint is unavailable");
    }
    return false;
  }
  const auto lock_path = lock_path_for_endpoint(endpoint);
  if (lock_path.isEmpty()) {
    if (error != nullptr) {
      *error = QStringLiteral("private single-instance lock location is unavailable");
    }
    return false;
  }
  auto lock = std::make_unique<QLockFile>(lock_path);
  lock->setStaleLockTime(5000);
  if (!lock->tryLock(0)) {
    if (error != nullptr) {
      *error = QStringLiteral("another process owns the single-instance endpoint");
    }
    return false;
  }
  impl_->lock = std::move(lock);
  if (impl_->server.listen(endpoint)) {
    if (error != nullptr) {
      error->clear();
    }
    return true;
  }

  // Remove only an endpoint that cannot be reached. Never unlink another live
  // process's listener merely because this process failed to become primary.
  QLocalSocket probe;
  probe.connectToServer(endpoint);
  if (probe.waitForConnected(200)) {
    probe.abort();
  } else {
    (void)QLocalServer::removeServer(endpoint);
    (void)impl_->server.listen(endpoint);
  }
  if (!impl_->server.isListening() && error != nullptr) {
    *error = impl_->server.errorString();
  }
  if (!impl_->server.isListening()) {
    impl_->lock.reset();
  }
  return impl_->server.isListening();
}

bool SingleInstanceServer::is_listening() const { return impl_->server.isListening(); }

QLocalServer::SocketOptions SingleInstanceServer::socket_options() const {
  return impl_->server.socketOptions();
}

}  // namespace patchy::app
