#include "app/single_instance_ipc.hpp"

#include "test_harness.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QLocalSocket>
#include <QTemporaryDir>
#include <QThread>
#include <QTimer>
#include <QUuid>
#include <QtEndian>

#include <chrono>
#include <cstdio>
#include <future>
#include <functional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using patchy::app::SingleInstanceDecodeState;

void set_u16(QByteArray& bytes, qsizetype offset, quint16 value) {
  qToBigEndian<quint16>(value, reinterpret_cast<uchar*>(bytes.data() + offset));
}

void set_u32(QByteArray& bytes, qsizetype offset, quint32 value) {
  qToBigEndian<quint32>(value, reinterpret_cast<uchar*>(bytes.data() + offset));
}

template <typename Result>
Result wait_with_events(std::future<Result>& future) {
  QElapsedTimer deadline;
  deadline.start();
  while (future.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) {
    QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
    QThread::msleep(1);
    if (deadline.elapsed() > 5000) {
      throw std::runtime_error("local IPC test timed out");
    }
  }
  QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
  return future.get();
}

QString unique_endpoint() {
  const auto name = QStringLiteral("PatchyIpcTest-") +
                    QUuid::createUuid().toString(QUuid::WithoutBraces);
#ifdef Q_OS_WIN
  return name;
#else
  return QDir(QFileInfo(patchy::app::single_instance_endpoint()).absolutePath())
      .filePath(name);
#endif
}

QByteArray send_raw(const QString& endpoint, const QByteArray& bytes) {
  QLocalSocket socket;
  socket.connectToServer(endpoint);
  if (!socket.waitForConnected(1000)) {
    return {};
  }
  if (socket.write(bytes) != bytes.size() || !socket.waitForBytesWritten(1000)) {
    return {};
  }
  if (!socket.waitForReadyRead(1000)) {
    return {};
  }
  return socket.readAll();
}

void frame_round_trip_and_commands() {
  QTemporaryDir directory;
  CHECK(directory.isValid());
  const auto image = directory.filePath(QStringLiteral("image.psd"));
  const auto shot = directory.filePath(QStringLiteral("shot.png"));
  const auto script = directory.filePath(QStringLiteral("task.js"));
  const auto output = directory.filePath(QStringLiteral("task.log"));
  const QStringList entries = {
      image,
      patchy::app::make_screenshot_command(shot, QStringLiteral("canvas"),
                                           QStringLiteral("1,2,30,40")),
      patchy::app::make_run_script_command(script, output,
                                           {QStringLiteral("quality=high"),
                                            QStringLiteral("mode=proof")}),
  };
  QString error;
  const auto frame = patchy::app::encode_single_instance_frame(entries, &error);
  CHECK(!frame.isEmpty());
  CHECK(error.isEmpty());
  const auto decoded = patchy::app::decode_single_instance_frame(frame);
  CHECK(decoded.state == SingleInstanceDecodeState::Accepted);
  CHECK(decoded.entries == entries);

  const auto screenshot = patchy::app::decode_screenshot_command(entries[1]);
  CHECK(screenshot.has_value());
  CHECK(screenshot->output_path == shot);
  CHECK(screenshot->widget_name == QStringLiteral("canvas"));
  CHECK(screenshot->region == QStringLiteral("1,2,30,40"));
  const auto run_script = patchy::app::decode_run_script_command(entries[2]);
  CHECK(run_script.has_value());
  CHECK(run_script->script_path == script);
  CHECK(run_script->output_path == output);
  CHECK(run_script->arguments ==
        QStringList({QStringLiteral("quality=high"), QStringLiteral("mode=proof")}));

  const auto empty = patchy::app::decode_single_instance_frame(
      patchy::app::encode_single_instance_frame({}));
  CHECK(empty.state == SingleInstanceDecodeState::Accepted);
  CHECK(empty.entries.isEmpty());
}

void malformed_frames_fail_closed() {
  QTemporaryDir directory;
  CHECK(directory.isValid());
  const QStringList entries = {directory.filePath(QStringLiteral("image.psd"))};
  const auto valid = patchy::app::encode_single_instance_frame(entries);
  CHECK(!valid.isEmpty());

  for (qsizetype length = 0; length < valid.size(); ++length) {
    CHECK(patchy::app::decode_single_instance_frame(valid.left(length)).state !=
          SingleInstanceDecodeState::Accepted);
  }

  auto mutated = valid;
  mutated[0] = 'X';
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  set_u16(mutated, 4, 2);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  set_u16(mutated, 6, 1);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  const auto payload_size = static_cast<quint32>(valid.size() -
                                                  patchy::app::kSingleInstanceHeaderBytes);
  set_u32(mutated, 8, payload_size - 1);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);
  mutated = valid;
  set_u32(mutated, 8, payload_size + 1);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Incomplete);

  mutated = valid;
  mutated.append('x');
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  set_u16(mutated, patchy::app::kSingleInstanceHeaderBytes,
          patchy::app::kSingleInstanceMaxEntries + 1);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  set_u32(mutated, patchy::app::kSingleInstanceHeaderBytes + 2,
          patchy::app::kSingleInstanceMaxEntryBytes + 1);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  mutated[patchy::app::kSingleInstanceHeaderBytes + 6] = static_cast<char>(0xff);
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  mutated = valid;
  mutated[patchy::app::kSingleInstanceHeaderBytes + 6] = '\0';
  CHECK(patchy::app::decode_single_instance_frame(mutated).state ==
        SingleInstanceDecodeState::Rejected);

  QByteArray oversized(patchy::app::kSingleInstanceMaxFrameBytes + 1, 'x');
  CHECK(patchy::app::decode_single_instance_frame(oversized).state ==
        SingleInstanceDecodeState::Rejected);
}

void encoder_rejects_invalid_request_shapes() {
  CHECK(patchy::app::encode_single_instance_frame({QStringLiteral("relative.psd")}).isEmpty());
  CHECK(patchy::app::encode_single_instance_frame(
            {QStringLiteral("patchy-cmd:unknown\n/value")})
            .isEmpty());

  QTemporaryDir directory;
  CHECK(directory.isValid());
  const auto shot = directory.filePath(QStringLiteral("shot.png"));
  CHECK(patchy::app::encode_single_instance_frame(
            {patchy::app::make_screenshot_command(shot, {}, QStringLiteral("bad"))})
            .isEmpty());
  CHECK(patchy::app::encode_single_instance_frame(
            {patchy::app::make_run_script_command(QStringLiteral("relative.js"), {}, {})})
            .isEmpty());

  QStringList too_many;
  for (int index = 0; index <= patchy::app::kSingleInstanceMaxEntries; ++index) {
    too_many.append(directory.filePath(QStringLiteral("%1.psd").arg(index)));
  }
  CHECK(patchy::app::encode_single_instance_frame(too_many).isEmpty());

  const QString huge(patchy::app::kSingleInstanceMaxEntryBytes + 1, QLatin1Char('a'));
  CHECK(patchy::app::encode_single_instance_frame(
            {QDir::rootPath() + huge})
            .isEmpty());
}

void endpoint_is_opaque_and_install_scoped() {
  const auto first = patchy::app::single_instance_endpoint_for_identity(
      QStringLiteral("/Users/alice"), QStringLiteral("/Applications/Patchy"));
  const auto repeat = patchy::app::single_instance_endpoint_for_identity(
      QStringLiteral("/Users/alice"), QStringLiteral("/Applications/Patchy"));
  const auto other_user = patchy::app::single_instance_endpoint_for_identity(
      QStringLiteral("/Users/bob"), QStringLiteral("/Applications/Patchy"));
  const auto other_install = patchy::app::single_instance_endpoint_for_identity(
      QStringLiteral("/Users/alice"), QStringLiteral("/opt/Patchy"));
  CHECK(first == repeat);
  CHECK(first != other_user);
  CHECK(first != other_install);
  CHECK(!first.contains(QStringLiteral("alice"), Qt::CaseInsensitive));
  CHECK(first.startsWith(QStringLiteral("PatchyInstance-")));
  CHECK(first.size() == QStringLiteral("PatchyInstance-").size() + 32);

  const auto live_endpoint = patchy::app::single_instance_endpoint();
  CHECK(!live_endpoint.isEmpty());
#ifndef Q_OS_WIN
  CHECK(QFileInfo(live_endpoint).isAbsolute());
  const QFileInfo directory(QFileInfo(live_endpoint).absolutePath());
  const auto forbidden = QFileDevice::ReadGroup | QFileDevice::WriteGroup |
                         QFileDevice::ExeGroup | QFileDevice::ReadOther |
                         QFileDevice::WriteOther | QFileDevice::ExeOther;
  CHECK(directory.isDir());
  CHECK(!directory.isSymLink());
  CHECK((directory.permissions() & forbidden) == 0);
#endif
}

void live_server_acknowledges_only_valid_frames() {
  const auto endpoint = unique_endpoint();
  int dispatch_count = 0;
  QStringList received;
  patchy::app::SingleInstanceServer server([&](QStringList entries) {
    ++dispatch_count;
    received = std::move(entries);
  });
  QString error;
  CHECK(server.listen(endpoint, &error));
  CHECK(error.isEmpty());
  CHECK(server.is_listening());
  CHECK(server.socket_options().testFlag(QLocalServer::UserAccessOption));

  int rival_dispatch_count = 0;
  patchy::app::SingleInstanceServer rival(
      [&](QStringList) { ++rival_dispatch_count; });
  QString rival_error;
  CHECK(!rival.listen(endpoint, &rival_error));
  CHECK(!rival.is_listening());
  CHECK(!rival_error.isEmpty());

  QTemporaryDir directory;
  CHECK(directory.isValid());
  const QStringList request = {directory.filePath(QStringLiteral("live.psd"))};
  auto valid_sender = std::async(std::launch::async, [&] {
    return patchy::app::forward_single_instance_request_to(endpoint, request, 2000);
  });
  CHECK(wait_with_events(valid_sender));
  CHECK(dispatch_count == 1);
  CHECK(received == request);
  CHECK(rival_dispatch_count == 0);

  auto malformed = patchy::app::encode_single_instance_frame(request);
  malformed[0] = 'X';
  auto invalid_sender = std::async(std::launch::async,
                                   [&] { return send_raw(endpoint, malformed); });
  CHECK(wait_with_events(invalid_sender).isEmpty());
  CHECK(dispatch_count == 1);

  auto truncated = patchy::app::encode_single_instance_frame(request);
  truncated.chop(1);
  auto truncated_sender = std::async(std::launch::async,
                                     [&] { return send_raw(endpoint, truncated); });
  CHECK(wait_with_events(truncated_sender).isEmpty());
  CHECK(dispatch_count == 1);
}

}  // namespace

int main(int argc, char* argv[]) {
  QCoreApplication app(argc, argv);
  const auto arguments = app.arguments();
  // Platform handoff mode: keep the same compiled component under test while an
  // isolated runner starts the sender under a second OS account. Exit 23 proves
  // the sender executable ran but did not receive a validated acknowledgement;
  // exit 24 proves the listener observed no dispatch before its deadline.
  if (arguments.size() == 2 && arguments[1] == QStringLiteral("--endpoint")) {
    const auto endpoint = patchy::app::single_instance_endpoint();
    if (endpoint.isEmpty()) {
      return 26;
    }
    std::printf("%s\n", endpoint.toUtf8().constData());
    return 0;
  }
  if (arguments.size() == 4 && arguments[1] == QStringLiteral("--send")) {
    const bool accepted = patchy::app::forward_single_instance_request_to(
        arguments[2], {QFileInfo(arguments[3]).absoluteFilePath()}, 2000);
    return accepted ? 0 : 23;
  }
  if (arguments.size() == 6 && arguments[1] == QStringLiteral("--serve")) {
    const auto endpoint = arguments[2];
    const auto ready_path = arguments[3];
    const auto dispatch_path = arguments[4];
    bool timeout_ok = false;
    const int timeout_ms = arguments[5].toInt(&timeout_ok);
    if (!timeout_ok || timeout_ms < 100 || timeout_ms > 30000) {
      return 22;
    }
    patchy::app::SingleInstanceServer server([&](QStringList) {
      QFile dispatch(dispatch_path);
      if (!dispatch.open(QIODevice::WriteOnly | QIODevice::NewOnly) ||
          dispatch.write("validated\n") < 0) {
        QCoreApplication::exit(25);
        return;
      }
      dispatch.close();
      QCoreApplication::exit(0);
    });
    if (!server.listen(endpoint)) {
      return 21;
    }
    QFile ready(ready_path);
    if (!ready.open(QIODevice::WriteOnly | QIODevice::NewOnly) ||
        ready.write("listening\n") < 0) {
      return 20;
    }
    ready.close();
    QTimer::singleShot(timeout_ms, &app, [] { QCoreApplication::exit(24); });
    return app.exec();
  }

  const std::vector<std::pair<const char*, std::function<void()>>> tests = {
      {"frame_round_trip_and_commands", frame_round_trip_and_commands},
      {"malformed_frames_fail_closed", malformed_frames_fail_closed},
      {"encoder_rejects_invalid_request_shapes", encoder_rejects_invalid_request_shapes},
      {"endpoint_is_opaque_and_install_scoped", endpoint_is_opaque_and_install_scoped},
      {"live_server_acknowledges_only_valid_frames",
       live_server_acknowledges_only_valid_frames},
  };
  int failed = 0;
  for (const auto& [name, test] : tests) {
    try {
      test();
      std::printf("[PASS] %s\n", name);
    } catch (const std::exception& exception) {
      ++failed;
      std::fprintf(stderr, "[FAIL] %s: %s\n", name, exception.what());
    }
  }
  return failed == 0 ? 0 : 1;
}
