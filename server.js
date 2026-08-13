import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ChzzkChat } from "./chzzk-chat.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const chatConnections = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      crypto.randomBytes(32).toString("hex"),

    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);


/* =========================================
   채팅 저장
========================================= */

const DATA_DIR = path.join(process.cwd(), "data");
const CHAT_DIR = path.join(DATA_DIR, "chats");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(CHAT_DIR)) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}


function safeFileName(value) {

  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
}


function getChannelId(req) {

  return (
    req.session.channelId ||
    req.session.userId ||
    "unknown"
  );

}


function getChatFile(req) {

  const channelId =
    safeFileName(getChannelId(req));

  return path.join(
    CHAT_DIR,
    `${channelId}.json`
  );

}


function loadSavedMessages(req) {

  const file =
    getChatFile(req);

  try {

    if (!fs.existsSync(file)) {
      return [];
    }

    const text =
      fs.readFileSync(file, "utf8");

    const data =
      JSON.parse(text);

    return Array.isArray(data)
      ? data
      : [];

  } catch (error) {

    console.error(
      "저장된 채팅 불러오기 오류:",
      error
    );

    return [];

  }

}


function saveMessages(req, messages) {

  const file =
    getChatFile(req);

  fs.writeFileSync(
    file,
    JSON.stringify(messages, null, 2),
    "utf8"
  );

}


function addMessages(req, newMessages) {

  if (!Array.isArray(newMessages)) {
    return;
  }

  const oldMessages =
    loadSavedMessages(req);

  const merged = [
    ...oldMessages,
    ...newMessages
  ];

  /*
   * 같은 채팅 ID가 있으면 중복 저장하지 않음
   */

  const seen = new Set();

  const result = [];

  for (const message of merged) {

    const id =
      message.id ||
      [
        message.timestamp,
        message.nickname,
        message.content
      ].join("|");

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);

    result.push({
      id,
      nickname:
        String(message.nickname || "알 수 없음"),

      content:
        String(message.content || ""),

      timestamp:
        message.timestamp ||
        Date.now()
    });

  }

  saveMessages(req, result);

}

/* =========================================
   저장된 채팅 내역
========================================= */

app.get("/api/chat/info", (req, res) => {

  try {

    if (!req.session.accessToken) {

      return res.status(401).json({
        error: "로그인이 필요합니다."
      });

    }

    const messages =
      loadSavedMessages(req);

    if (messages.length === 0) {

      return res.json({
        count: 0,
        firstTimestamp: null,
        lastTimestamp: null
      });

    }

    const timestamps =
      messages
        .map(message =>
          Number(message.timestamp)
        )
        .filter(timestamp =>
          Number.isFinite(timestamp)
        );


    res.json({

      count:
        messages.length,

      firstTimestamp:
        timestamps.length
          ? Math.min(...timestamps)
          : null,

      lastTimestamp:
        timestamps.length
          ? Math.max(...timestamps)
          : null

    });

  } catch (error) {

    console.error(
      "채팅 내역 조회 오류:",
      error
    );

    res.status(500).json({

      error:
        "채팅 내역을 불러오지 못했습니다."

    });

  }

});

/* =========================================
   로그인
========================================= */

function randomState() {

  return crypto
    .randomBytes(24)
    .toString("hex");

}


function escapeHtml(value) {

  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );

}


/* =========================================
   치지직 로그인 시작
========================================= */

app.get("/auth/login", (req, res) => {

  try {

    const clientId =
      process.env.CHZZK_CLIENT_ID;

    const clientSecret =
      process.env.CHZZK_CLIENT_SECRET;

    const redirectUri =
      process.env.CHZZK_REDIRECT_URI ||
      `http://localhost:${PORT}/auth/callback`;

    if (!clientId) {

      return res.status(500).send(
        "CHZZK_CLIENT_ID가 .env에 없습니다."
      );

    }

    if (!clientSecret) {

      return res.status(500).send(
        "CHZZK_CLIENT_SECRET이 .env에 없습니다."
      );

    }

    const state =
      randomState();

    req.session.oauthState =
      state;

    const params =
      new URLSearchParams({
        response_type: "code",
        clientId,
        redirectUri,
        state
      });

    const loginUrl =
      `https://chzzk.naver.com/account-interlock?${params.toString()}`;

    res.redirect(loginUrl);

  } catch (error) {

    console.error(
      "치지직 로그인 시작 오류:",
      error
    );

    res.status(500).send(
      `로그인 시작 실패: ${escapeHtml(error.message)}`
    );

  }

});


/* =========================================
   로그인 콜백
========================================= */

app.get("/auth/callback", async (req, res) => {

  try {

    const code =
      String(req.query.code || "");

    const state =
      String(req.query.state || "");

    if (!code) {
      throw new Error(
        "authorization code를 받지 못했습니다."
      );
    }

    if (!state) {
      throw new Error(
        "state를 받지 못했습니다."
      );
    }

    if (
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {

      throw new Error(
        "로그인 상태 확인에 실패했습니다."
      );

    }

    const clientId =
      process.env.CHZZK_CLIENT_ID;

    const clientSecret =
      process.env.CHZZK_CLIENT_SECRET;

    const redirectUri =
      process.env.CHZZK_REDIRECT_URI ||
      `http://localhost:${PORT}/auth/callback`;

    if (!clientId) {
      throw new Error(
        "CHZZK_CLIENT_ID가 없습니다."
      );
    }

    if (!clientSecret) {
      throw new Error(
        "CHZZK_CLIENT_SECRET이 없습니다."
      );
    }

    const response =
      await fetch(
        "https://openapi.chzzk.naver.com/auth/v1/token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            grantType:
              "authorization_code",

            clientId,
            clientSecret,
            code,
            state

          })
        }
      );

    const tokenText =
      await response.text();

    let token;

    try {

      token =
        JSON.parse(tokenText);

    } catch {

      throw new Error(
        "토큰 API 응답이 JSON이 아닙니다."
      );

    }

    if (!response.ok) {

      throw new Error(
        "토큰 발급 실패: " +
        (
          token.message ||
          token.error ||
          JSON.stringify(token)
        )
      );

    }

    const content =
      token.content || token;

    if (!content.accessToken) {

      throw new Error(
        "accessToken을 받지 못했습니다."
      );

    }

    req.session.accessToken =
      content.accessToken;

    req.session.refreshToken =
      content.refreshToken || null;

    delete req.session.oauthState;
    /*
     * 사용자 정보 확보
     */

    const meResponse =
      await fetch(
        "https://openapi.chzzk.naver.com/open/v1/users/me",
        {
          headers: {
            Authorization:
              "Bearer " +
              req.session.accessToken
          }
        }
      );

    const meData =
      await meResponse.json();

    const me =
      meData.content || meData;

    req.session.userId =
      me.userId ||
      me.id ||
      me.channelId ||
      null;

    req.session.channelId =
      me.channelId ||
      me.userId ||
      me.id ||
      null;


    /*
     * 방송 자동 감시 시작
     */

    await startLiveWatcher(req);
    res.redirect("/");

  } catch (error) {

    console.error(
      "치지직 로그인 오류:",
      error
    );

    res.status(400).send(`
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>로그인 실패</title>
<style>
body{
  background:#080808;
  color:#eee;
  font-family:Arial,sans-serif;
  padding:40px;
}
.box{
  max-width:600px;
  margin:80px auto;
  border:1px solid #333;
  padding:30px;
  background:#111;
  border-radius:12px;
}
h2{
  color:#ff6262;
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  color:#aaa;
}
a{
  color:#00d564;
}
</style>
</head>

<body>

<div class="box">

<h2>로그인 실패</h2>

<pre>${escapeHtml(error.message)}</pre>

<a href="/">
후던챗으로 돌아가기
</a>

</div>

</body>
</html>
    `);

  }

});


/* =========================================
   내 계정
========================================= */

app.get("/api/me", async (req, res) => {

  try {

    if (!req.session.accessToken) {

      return res.json({
        loggedIn: false
      });

    }

    const response =
      await fetch(
        "https://openapi.chzzk.naver.com/open/v1/users/me",
        {
          headers: {
            Authorization:
              "Bearer " +
              req.session.accessToken
          }
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      return res.json({
        loggedIn: false,
        error:
          data.message ||
          "치지직 API 오류"
      });

    }

    const me =
      data.content || data;

    /*
     * 사용자 식별값 저장
     */

    req.session.userId =
      me.userId ||
      me.id ||
      me.channelId ||
      null;

    req.session.channelId =
      me.channelId ||
      me.userId ||
      me.id ||
      null;

    res.json({

      loggedIn: true,

      me

    });

  } catch (error) {

    console.error(
      "내 계정 확인 오류:",
      error
    );

    res.json({

      loggedIn: false,

      error:
        error.message

    });

  }

});


/* =========================================
   저장된 채팅 전체 조회
========================================= */

app.get(
  "/api/chat/history",
  (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({
          error:
            "로그인이 필요합니다."
        });

      }

      const messages =
        loadSavedMessages(req);

      res.json({

        messages,

        count:
          messages.length

      });

    } catch (error) {

      console.error(
        "채팅 기록 조회 오류:",
        error
      );

      res.status(500).json({

        error:
          "채팅 기록을 불러오지 못했습니다."

      });

    }

  }
);


/* =========================================
   새로운 채팅 저장
========================================= */

/*
 * 실제 치지직 채팅 수신 코드에서
 * 채팅이 들어올 때 이 함수를 호출하면 됨.
 *
 * 예:
 *
 * addMessages(req, [
 *   {
 *     id: "채팅ID",
 *     nickname: "철수",
 *     content: "ㅋㅋㅋㅋ",
 *     timestamp: Date.now()
 *   }
 * ]);
 *
 */

app.post(
  "/api/chat/save",
  (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({
          error:
            "로그인이 필요합니다."
        });

      }

      const incoming =
        req.body.messages;

      if (!Array.isArray(incoming)) {

        return res.status(400).json({
          error:
            "messages 배열이 필요합니다."
        });

      }

      addMessages(
        req,
        incoming
      );

      const messages =
        loadSavedMessages(req);

      res.json({

        success: true,

        count:
          messages.length

      });

    } catch (error) {

      console.error(
        "채팅 저장 오류:",
        error
      );

      res.status(500).json({

        error:
          "채팅 저장에 실패했습니다."

      });

    }

  }
);


/* =========================================
   저장된 채팅 삭제
========================================= */

app.delete(
  "/api/chat/history",
  (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({
          error:
            "로그인이 필요합니다."
        });

      }

      const file =
        getChatFile(req);

      if (fs.existsSync(file)) {

        fs.unlinkSync(file);

      }

      res.json({
        success: true
      });

    } catch (error) {

      console.error(
        "채팅 삭제 오류:",
        error
      );

      res.status(500).json({
        error:
          "채팅 기록 삭제에 실패했습니다."
      });

    }

  }
);


/* =========================================
   서버 실행
========================================= */
/* =========================================
   치지직 실시간 채팅 수집
========================================= */

let chzzkSocket = null;
let collecting = false;
let currentBroadcast = null;

/* =========================================
   방송 감시 대상
========================================= */

const liveWatchers = new Map();

/*
  channelId 기준으로 저장

  {
    channelId,
    accessToken,
    req,
    isLive,
    liveId,
    liveInfo,
    timer
  }
*/


/* =========================================
   현재 방송 확인
========================================= */

async function getCurrentLive(channelId) {

  const clientId =
    process.env.CHZZK_CLIENT_ID;

  const clientSecret =
    process.env.CHZZK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {

    throw new Error(
      "CHZZK_CLIENT_ID 또는 CHZZK_CLIENT_SECRET이 없습니다."
    );

  }

  const response =
    await fetch(
      "https://openapi.chzzk.naver.com/open/v1/lives?size=20",
      {
        method: "GET",

        headers: {
          "Client-Id": clientId,
          "Client-Secret": clientSecret
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {

    data = JSON.parse(text);

  } catch {

    throw new Error(
      "CHZZK 라이브 API 응답이 JSON이 아닙니다."
    );

  }

  if (!response.ok) {

    throw new Error(
      "CHZZK 방송 상태 조회 실패: " +
      (
        data.message ||
        data.error ||
        JSON.stringify(data)
      )
    );

  }

  const content =
    data.content || data;

  const lives =
    Array.isArray(content.data)
      ? content.data
      : [];

  return (
    lives.find(
      live =>
        String(live.channelId) ===
        String(channelId)
    ) || null
  );

}


/* =========================================
   방송 상태 확인
========================================= */

async function checkLiveWatcher(channelId) {

  const watcher =
    liveWatchers.get(channelId);

  if (!watcher) {
    return;
  }

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
      watcher.liveId =
        live.liveId;

      watcher.liveInfo =
        live;


      /*
       * 자동으로 채팅 수집 시작
       */

      try {

        await startChatCollection(
          watcher.req
        );

        console.log(
          "✅ 방송 시작 → 채팅 자동 수집 시작"
        );

      } catch (error) {

        console.error(
          "방송 시작 후 채팅 수집 실패:",
          error
        );

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
          "방송 종료 후 채팅 연결 종료 실패:",
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

  }

}


/* =========================================
   방송 감시 시작
========================================= */

async function startLiveWatcher(req) {

  const channelId =
    req.session.channelId ||
    req.session.userId;

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
   * 이미 감시 중이면 기존 감시 유지
   */

  if (liveWatchers.has(channelId)) {

    const watcher =
      liveWatchers.get(channelId);

    watcher.req = req;
    watcher.accessToken =
      accessToken;

    return;

  }


  const watcher = {

    channelId,

    accessToken,

    req,

    isLive: false,

    liveId: null,

    liveInfo: null,

    timer: null

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
   * 로그인 직후 바로 한 번 확인
   */

  await checkLiveWatcher(
    channelId
  );


  /*
   * 이후 10초마다 확인
   */

  watcher.timer =
    setInterval(
      () => {

        checkLiveWatcher(
          channelId
        );

      },
      10000
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

  if (watcher.timer) {

    clearInterval(
      watcher.timer
    );

  }

  liveWatchers.delete(
    channelId
  );

  console.log(
    "방송 감시 종료:",
    channelId
  );

}

/* =========================================
   CHZZK 방송 상태 확인
========================================= */

  const response =
    await fetch(
      "https://openapi.chzzk.naver.com/open/v1/lives?size=20",
      {
        method: "GET",

        headers: {
          "Client-Id": clientId,
          "Client-Secret": clientSecret
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "CHZZK 라이브 API 응답이 JSON이 아닙니다."
    );
  }

  if (!response.ok) {
    throw new Error(
      "CHZZK 라이브 상태 조회 실패: " +
      (
        data.message ||
        data.error ||
        JSON.stringify(data)
      )
    );
  }

  const content =
    data.content || data;

  const lives =
    content.data ||
    content.lives ||
    [];

  if (!Array.isArray(lives)) {
    return null;
  }

  return (
    lives.find(
      live =>
        String(live.channelId) ===
        String(channelId)
    ) || null
  );

}

/* =========================================
   방송 상태 자동 감시
========================================= */

async function checkBroadcastStatus() {

  try {

    /*
     * 로그인한 채널이 있는 세션을 찾음
     */

    let targetChannelId = null;
    let targetReq = null;

    /*
     * 현재 연결된 채널이 있다면 우선 사용
     */

    for (const [channelId] of chatConnections) {

      targetChannelId = channelId;
      break;

    }

    /*
     * 아직 채팅 연결이 없다면
     * 여기서는 자동 감시를 위해 별도 세션 정보가 필요함.
     *
     * 아래 방식으로는 로그인 세션을 직접 순회할 수 없기 때문에
     * 실제 자동 시작은 로그인 직후 해당 세션에서 감시를 시작해야 함.
     */

    if (!targetChannelId) {
      return;
    }

    const live =
      await getCurrentLive(
        targetChannelId
      );

    const isLive =
      !!live;

    /*
     * 방송 시작
     */

    if (
      isLive &&
      !lastLiveState
    ) {

      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "🔴 방송 시작 감지!"
      );
      console.log(
        "채널:",
        targetChannelId
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

      currentLiveInfo =
        live;

      lastLiveState = true;

    }


    /*
     * 방송 종료
     */

    if (
      !isLive &&
      lastLiveState
    ) {

      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "⚫ 방송 종료 감지!"
      );
      console.log(
        "================================="
      );

      lastLiveState = false;
      currentLiveInfo = null;

      /*
       * 실제 채팅 연결이 있다면 종료
       */

      /*
       * stopChatCollection()은
       * req가 필요하기 때문에
       * 여기서는 다음 단계에서 세션 구조와
       * 같이 연결해주는 게 좋음.
       */

    }

  } catch (error) {

    console.error(
      "[방송 상태 확인 오류]",
      error.message
    );

  }

}

/* =========================================
   방송 세션
========================================= */

function createBroadcastSession(req, liveInfo = null) {

  const channelId =
    safeFileName(getChannelId(req));

  const broadcastId =
    liveInfo?.liveId ||
    `${Date.now()}`;

  const broadcastDir =
    path.join(
      CHAT_DIR,
      channelId
    );

  if (!fs.existsSync(broadcastDir)) {

    fs.mkdirSync(
      broadcastDir,
      { recursive: true }
    );

  }

  const file =
    path.join(
      broadcastDir,
      `${broadcastId}.json`
    );

  const broadcast = {

    id: broadcastId,

    channelId,

    liveId:
      liveInfo?.liveId ||
      null,

    title:
      liveInfo?.liveTitle ||
      null,

    startedAt: Date.now(),

    messages: []

  };

  fs.writeFileSync(
    file,
    JSON.stringify(
      broadcast,
      null,
      2
    ),
    "utf8"
  );

  currentBroadcast = {
    ...broadcast,
    file
  };

  console.log("");
  console.log("===== 방송 세션 생성 =====");
  console.log("방송 ID:", broadcastId);
  console.log("저장 파일:", file);
  console.log("==========================");

  return currentBroadcast;

}


function saveBroadcastMessages(messages) {

  if (!currentBroadcast) {
    return;
  }

  if (!Array.isArray(messages)) {
    return;
  }

  currentBroadcast.messages.push(
    ...messages
  );

  fs.writeFileSync(
    currentBroadcast.file,
    JSON.stringify(
      currentBroadcast,
      null,
      2
    ),
    "utf8"
  );

}

async function startChatCollection(req) {

  if (!req.session.accessToken) {
    throw new Error("치지직 로그인이 필요합니다.");
  }

  const channelId =
    req.session.channelId ||
    req.session.userId;
const watcher =
  liveWatchers.get(channelId);

const liveInfo =
  watcher?.liveInfo || null;
  if (!channelId) {
    throw new Error("치지직 채널 ID를 확인할 수 없습니다.");
  }

  /*
   * 이미 이 방송인의 채팅 연결이 있으면
   * 새로 만들지 않음
   */

  if (chatConnections.has(channelId)) {

    const existing =
      chatConnections.get(channelId);

    if (existing.collecting) {
      return;
    }

  }


  console.log("");
  console.log("===== 채팅 수집 시작 =====");
  console.log("채널 ID:", channelId);


  /*
   * 방송별 저장 파일 생성
   */

  const broadcast =
  createBroadcastSession(
    req,
    liveInfo
  );


  /*
   * 이 방송인 전용 채팅 연결
   */

  const chatClient =
    new ChzzkChat({

      accessToken:
        req.session.accessToken,

      channelId:
        channelId,

      onChat: (chat) => {

        console.log(
          "[후던챗 채팅 저장]",
          chat.nickname,
          chat.content
        );


        /*
         * 방송별 저장
         */

        saveBroadcastMessages([
          chat
        ]);


        /*
         * 기존 전체 채팅 저장
         */

        addMessages(
          req,
          [chat]
        );

      },


      onStatus: (message) => {

        console.log(
          `[후던챗 ${channelId}]`,
          message
        );

      }

    });


  /*
   * 서버에 연결 정보 등록
   */

  chatConnections.set(
    channelId,
    {
      chatClient,
      collecting: true,
      broadcast
    }
  );


  try {

    await chatClient.connect();

    console.log(
      "실시간 채팅 연결 완료:",
      channelId
    );

  } catch (error) {

    /*
     * 연결 실패하면 Map에서도 제거
     */

    chatConnections.delete(
      channelId
    );

    throw error;

  }

}


function stopChatCollection(req) {

  const channelId =
    req.session.channelId ||
    req.session.userId;

  if (!channelId) {
    return;
  }

  const connection =
    chatConnections.get(channelId);

  if (!connection) {
    console.log(
      "실행 중인 채팅 연결이 없습니다:",
      channelId
    );
    return;
  }


  /*
   * 치지직 채팅 연결 종료
   */

  try {

    connection.chatClient.disconnect();

  } catch (error) {

    console.error(
      "채팅 연결 종료 오류:",
      error
    );

  }


  /*
   * 방송 종료 시간 저장
   */

  if (connection.broadcast) {

    connection.broadcast.endedAt =
      Date.now();

    try {

      fs.writeFileSync(
        connection.broadcast.file,
        JSON.stringify(
          connection.broadcast,
          null,
          2
        ),
        "utf8"
      );

    } catch (error) {

      console.error(
        "방송 세션 저장 오류:",
        error
      );

    }

  }


  /*
   * 연결 목록에서 제거
   */

  chatConnections.delete(
    channelId
  );


  console.log(
    "채팅 수집 중지:",
    channelId
  );

}

/* 채팅 수집 시작 API */

app.post(
  "/api/live/start",
  async (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({
          error:
            "치지직 로그인이 필요합니다."
        });

      }

      await startChatCollection(req);

      res.json({
        success: true,
        collecting: true
      });

    } catch (error) {

      console.error(
        "실시간 채팅 시작 오류:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "채팅 수집을 시작할 수 없습니다."
      });

    }

  }
);


/* 채팅 수집 중지 API */

app.post(
  "/api/live/stop",
  (req, res) => {

    stopChatCollection(req);

    res.json({
      success: true,
      collecting: false
    });

  }
);


/* 저장된 채팅 가져오기 */

app.get(
  "/api/live/messages",
  (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({
          error:
            "로그인이 필요합니다."
        });

      }

      const messages =
        loadSavedMessages(req);

      res.json({
        messages,
        count: messages.length,
        collecting
      });

    } catch (error) {

      console.error(
        "채팅 조회 오류:",
        error
      );

      res.status(500).json({
        error:
          "채팅을 불러오지 못했습니다."
      });

    }

  }
);
app.listen(PORT, () => {

  console.log("");
  console.log(
    "================================="
  );
  console.log(
    "후던챗 서버 실행 완료"
  );
  console.log(
    "http://localhost:" + PORT
  );
  console.log(
    "채팅 저장 폴더:",
    CHAT_DIR
  );
  console.log(
    "================================="
  );

});