#pragma once

#include <QByteArray>
#include <QLocalServer>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>

namespace patchy::app {

inline constexpr qsizetype kSingleInstanceHeaderBytes = 12;
inline constexpr qsizetype kSingleInstanceMaxPayloadBytes = 1024 * 1024;
inline constexpr qsizetype kSingleInstanceMaxFrameBytes =
    kSingleInstanceHeaderBytes + kSingleInstanceMaxPayloadBytes;
inline constexpr qsizetype kSingleInstanceMaxEntryBytes = 256 * 1024;
inline constexpr quint16 kSingleInstanceMaxEntries = 256;

enum class SingleInstanceDecodeState { Incomplete, Accepted, Rejected };

struct SingleInstanceDecodeResult {
  SingleInstanceDecodeState state = SingleInstanceDecodeState::Incomplete;
  QStringList entries;
  QString error;
};

struct ScreenshotCommand {
  QString output_path;
  QString widget_name;
  QString region;
};

struct RunScriptCommand {
  QString script_path;
  QString output_path;
  QStringList arguments;
};

QString single_instance_endpoint();
QString single_instance_endpoint_for_identity(const QString& home_path,
                                              const QString& installation_path);

QString make_screenshot_command(const QString& output_path, const QString& widget_name,
                                const QString& region);
QString make_run_script_command(const QString& script_path, const QString& output_path,
                                const QStringList& arguments);
std::optional<ScreenshotCommand> decode_screenshot_command(const QString& entry);
std::optional<RunScriptCommand> decode_run_script_command(const QString& entry);

QByteArray encode_single_instance_frame(const QStringList& entries, QString* error = nullptr);
SingleInstanceDecodeResult decode_single_instance_frame(const QByteArray& frame);
QByteArray single_instance_acknowledgement();

bool forward_single_instance_request(const QStringList& entries, int timeout_ms = 1000);
bool forward_single_instance_request_to(const QString& endpoint, const QStringList& entries,
                                        int timeout_ms = 1000);

// Owns the local listener and admits only complete, validated requests. The callback is
// never invoked for a partial, malformed, oversized, or trailing-byte frame.
class SingleInstanceServer {
 public:
  using RequestHandler = std::function<void(QStringList)>;

  explicit SingleInstanceServer(RequestHandler handler);
  ~SingleInstanceServer();

  SingleInstanceServer(const SingleInstanceServer&) = delete;
  SingleInstanceServer& operator=(const SingleInstanceServer&) = delete;

  bool listen(const QString& endpoint, QString* error = nullptr);
  bool is_listening() const;
  QLocalServer::SocketOptions socket_options() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace patchy::app
