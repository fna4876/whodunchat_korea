/* =========================================
   방송 감시
========================================= */

async function checkLiveWatcher(channelId) {

  const watcher =
    liveWatchers.get(channelId);

  if (!watcher) {
    return;
  }

  /*
   * 이미 확인 중이면 중복 실행 방지
   */
  if (watcher.checking) {
    return;
  }

  watcher.checking = true;

  try {

    const live =
      await getCurrentLive(channelId);

    const isLive =
      !!live;

    /*
     * 방송 시작
     */

    if (
      isLive &&
      !watcher.isLive
    ) {

      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "🔴 방송 시작 감지"
      );
      console.log(
        "채널 ID:",
        channelId
      );
      console.log(
        "방송 ID:",
        live.liveId
      );
      console.log(
        "방송 제목:",
        live.liveTitle
      );
      console.log(
        "================================="
      );

      watcher.isLive = true;
      watcher.liveId = live.liveId;
      watcher.liveInfo = live;

      try {

        await startChatCollection(
          watcher.req
        );

        console.log(
          "✅ 방송 시작 → 채팅 자동 수집 시작"
        );

      } catch (error) {

        console.error(
          "❌ 채팅 수집 시작 실패:",
          error.message
        );

      }
    }

    /*
     * 방송 중
     */

    if (isLive) {

      watcher.isLive = true;
      watcher.liveId = live.liveId;
      watcher.liveInfo = live;

      /*
       * 방송은 켜져 있는데
       * 채팅 연결이 끊겼으면 다시 연결
       */

      const connection =
        chatConnections.get(channelId);

      if (
        !connection ||
        !connection.collecting
      ) {

        console.log(
          "⚠️ 방송 중인데 채팅 연결 없음 → 재연결"
        );

        try {

          await startChatCollection(
            watcher.req
          );

        } catch (error) {

          console.error(
            "채팅 자동 재연결 실패:",
            error.message
          );

        }

      }
    }

    /*
     * 방송 종료
     */

    if (
      !isLive &&
      watcher.isLive
    ) {

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

      watcher.isLive = false;
      watcher.liveId = null;
      watcher.liveInfo = null;
    }

  } catch (error) {

    console.error(
      `[방송 상태 확인 오류] ${channelId}:`,
      error.message
    );

    /*
     * API 오류가 발생했다고
     * 방송 종료로 판단하지 않음
     */

  } finally {

    watcher.checking = false;

    /*
     * 이번 확인이 끝난 후
     * 10초 뒤 다시 확인
     */

    if (
      liveWatchers.has(channelId) &&
      !watcher.stopped
    ) {

      if (watcher.timer) {
        clearTimeout(watcher.timer);
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

  /*
   * 감시 중지 표시
   */
  watcher.stopped = true;

  /*
   * 예약된 다음 확인 취소
   */
  if (watcher.timer) {

    clearTimeout(
      watcher.timer
    );

    watcher.timer = null;
  }

  /*
   * 감시자 삭제
   */
  liveWatchers.delete(
    channelId
  );

  console.log(
    "방송 감시 종료:",
    channelId
  );
}