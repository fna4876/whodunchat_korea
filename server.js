/* =========================================
   방송 감시
========================================= */

/* =========================================
   방송 감시
========================================= */

async function checkLiveWatcher(channelId) {

  const watcher =
    liveWatchers.get(channelId);

  if (!watcher) {
    return;
  }

  // 이미 확인 중이면 중복 실행 방지
  if (watcher.checking) {
    return;
  }

  watcher.checking = true;

  try {

    console.log(
      `[방송 감시] ${new Date().toLocaleTimeString("ko-KR")} 방송 상태 확인`
    );

    const live =
      await getCurrentLive(channelId);

    const isLive =
      !!live;

    /*
     * =====================================
     * 방송 중
     * =====================================
     */

    if (isLive) {

      const previousLiveId =
        watcher.liveId;

      watcher.isLive = true;
      watcher.liveId =
        live.liveId || null;

      watcher.liveInfo =
        live;

      console.log(
        "🔴 현재 방송 중:",
        live.liveTitle || "(제목 없음)"
      );

      console.log(
        "방송 ID:",
        live.liveId
      );

      /*
       * 새로운 방송이 시작된 경우
       */

      if (
        !previousLiveId ||
        previousLiveId !== live.liveId
      ) {

        console.log(
          "🆕 새로운 방송 감지"
        );

        try {

          await startChatCollection(
            watcher.req
          );

          console.log(
            "✅ 새로운 방송 → 채팅 수집 시작"
          );

        } catch (error) {

          console.error(
            "❌ 채팅 수집 시작 실패:",
            error.message
          );

        }

      }

      /*
       * 방송 중인데 채팅 연결이 없는 경우
       */

      const connection =
        chatConnections.get(
          channelId
        );

      if (
        !connection ||
        !connection.collecting
      ) {

        console.log(
          "⚠️ 방송 중인데 채팅 연결 없음"
        );

        console.log(
          "🔄 채팅 연결 재시도"
        );

        try {

          await startChatCollection(
            watcher.req
          );

          console.log(
            "✅ 채팅 자동 재연결 성공"
          );

        } catch (error) {

          console.error(
            "❌ 채팅 자동 재연결 실패:",
            error.message
          );

        }

      }

    }

    /*
     * =====================================
     * 방송 종료
     * =====================================
     */

    else {

      /*
       * 실제로 방송 중이었다가
       * 종료된 경우에만 종료 처리
       */

      if (watcher.isLive) {

        console.log("");
        console.log(
          "================================="
        );
        console.log(
          "⚫ 방송 종료 감지"
        );
        console.log(
          "채널 ID:",
          channelId
        );
        console.log(
          "================================="
        );

        try {

          stopChatCollection(
            watcher.req
          );

        } catch (error) {

          console.error(
            "방송 종료 처리 오류:",
            error
          );

        }

      }

      watcher.isLive =
        false;

      watcher.liveId =
        null;

      watcher.liveInfo =
        null;

    }

  } catch (error) {

    /*
     * =====================================
     * API 오류
     * =====================================
     *
     * 중요:
     * API 오류가 발생했다고
     * 방송 종료로 판단하지 않는다.
     */

    console.error(
      `[방송 감시 API 오류] ${channelId}:`,
      error.message
    );

    console.log(
      "⚠️ 이번 확인은 실패했지만 감시는 계속합니다."
    );

  } finally {

    watcher.checking =
      false;

    /*
     * =====================================
     * 다음 확인 예약
     * =====================================
     */

    if (
      liveWatchers.has(channelId) &&
      !watcher.stopped
    ) {

      if (watcher.timer) {

        clearTimeout(
          watcher.timer
        );

      }

      watcher.timer =
        setTimeout(
          () => {

            checkLiveWatcher(
              channelId
            );

          },
          10000
        );

      console.log(
        "⏱️ 다음 방송 상태 확인: 10초 후"
      );

    }

  }

}

/* =========================================
   방송 감시 시작
========================================= */

async function startLiveWatcher(req) {

  const channelId =
    getChannelId(req);

  const accessToken =
    req.session.accessToken;

  if (!channelId) {
    throw new Error(
      "채널 ID가 없습니다."
    );
  }

  if (!accessToken) {
    throw new Error(
      "Access Token이 없습니다."
    );
  }

  /*
   * 이미 감시 중이면
   * 세션 정보만 최신화
   */

  if (liveWatchers.has(channelId)) {

    const watcher =
      liveWatchers.get(channelId);

    watcher.req = req;
    watcher.accessToken = accessToken;
    watcher.stopped = false;

    return;
  }

  const watcher = {

    channelId,

    accessToken,

    req,

    isLive: false,

    liveId: null,

    liveInfo: null,

    timer: null,

    checking: false,

    stopped: false

  };

  liveWatchers.set(
    channelId,
    watcher
  );

  console.log("");
  console.log(
    "===== 방송 감시 시작 ====="
  );
  console.log(
    "채널 ID:",
    channelId
  );
  console.log(
    "10초마다 방송 상태 확인"
  );
  console.log(
    "=========================="
  );

  /*
   * 로그인 직후 즉시 확인
   */

  await checkLiveWatcher(
    channelId
  );
}

/* =========================================
   방송 감시 중지
========================================= */

function stopLiveWatcher(channelId) {

  const watcher =
    liveWatchers.get(channelId);

  if (!watcher) {
    return;
  }

  watcher.stopped =
    true;

  if (watcher.timer) {

    clearTimeout(
      watcher.timer
    );

    watcher.timer =
      null;

  }

  liveWatchers.delete(
    channelId
  );

  console.log(
    "방송 감시 종료:",
    channelId
  );

}