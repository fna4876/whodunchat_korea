import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ChzzkChat } from "./chzzk-chat.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

/* =========================================
   전역 상태
========================================= */

const chatConnections = new Map();
const liveWatchers = new Map();

/* =========================================
   Express
========================================= */

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
   채팅 저장 폴더
========================================= */

const DATA_DIR =
  path.join(process.cwd(), "data");

const CHAT_DIR =
  path.join(DATA_DIR, "chats");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(CHAT_DIR)) {
  fs.mkdirSync(CHAT_DIR, {
    recursive: true
  });
}

/* =========================================
   유틸
========================================= */

function safeFileName(value) {
  return String(value || "unknown")
    .replace(
      /[^a-zA-Z0-9가-힣_-]/g,
      "_"
    );
}

function getChannelId(req) {
  return (
    req.session.channelId ||
    req.session.userId ||
    null
  );
}

function getChatFile(req) {
  const channelId =
    safeFileName(
      getChannelId(req) || "unknown"
    );

  return path.join(
    CHAT_DIR,
    `${channelId}.json`
  );
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

function randomState() {
  return crypto
    .randomBytes(24)
    .toString("hex");
}

/* =========================================
   저장된 채팅 불러오기
========================================= */

function loadSavedMessages(req) {
  const file =
    getChatFile(req);

  try {
    if (!fs.existsSync(file)) {
      return [];
    }

    const text =
      fs.readFileSync(
        file,
        "utf8"
      );

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

/* =========================================
   채팅 저장
========================================= */

function saveMessages(
  req,
  messages
) {
  const file =
    getChatFile(req);

  fs.writeFileSync(
    file,
    JSON.stringify(
      messages,
      null,
      2
    ),
    "utf8"
  );
}

function addMessages(
  req,
  newMessages
) {

  if (!Array.isArray(newMessages)) {
    return;
  }

  const oldMessages =
    loadSavedMessages(req);

  const merged = [
    ...oldMessages,
    ...newMessages
  ];

  const seen =
    new Set();

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
        String(
          message.nickname ||
          "알 수 없음"
        ),

      content:
        String(
          message.content ||
          ""
        ),

      timestamp:
        message.timestamp ||
        Date.now()

    });
  }

  saveMessages(
    req,
    result
  );
}

/* =========================================
   치지직 현재 방송 확인
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

  console.log("");
  console.log("=================================");
  console.log("🔎 방송 상태 API 확인");
  console.log("내 channelId:", channelId);
  console.log("=================================");

  let next = null;

  for (let page = 0; page < 20; page++) {

    const params =
      new URLSearchParams({
        size: "20"
      });

    if (next) {
      params.set("next", next);
    }

    const url =
      `https://openapi.chzzk.naver.com/open/v1/lives?${params.toString()}`;

    console.log("라이브 API 요청:", url);

    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            "Client-Id":
              clientId,

            "Client-Secret":
              clientSecret
          }
        }
      );

    const text =
      await response.text();

    console.log(
      "라이브 API 상태:",
      response.status
    );

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      console.error(
        "라이브 API 원본 응답:",
        text
      );

      throw new Error(
        "CHZZK 라이브 API 응답이 JSON이 아닙니다."
      );

    }

    if (!response.ok) {

      console.error(
        "라이브 API 오류:",
        data
      );

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

    console.log(
      `현재 ${lives.length}개 방송 확인`
    );

    /*
     * 현재 방송 목록 출력
     */

    for (const live of lives) {

      console.log(
        "방송:",
        {
          liveId:
            live.liveId,

          channelId:
            live.channelId,

          channelName:
            live.channelName,

          title:
            live.liveTitle
        }
      );

    }

    /*
     * 내 채널 찾기
     */

    const found =
      lives.find(
        live =>
          String(live.channelId).trim() ===
          String(channelId).trim()
      );

    if (found) {

      console.log("");
      console.log(
        "🔴 내 방송 발견!"
      );

      console.log(
        "방송 ID:",
        found.liveId
      );

      console.log(
        "방송 제목:",
        found.liveTitle
      );

      console.log(
        "채널 ID:",
        found.channelId
      );

      console.log("");

      return found;

    }

    next =
      content.page?.next ||
      null;

    console.log(
      "다음 페이지:",
      next
    );

    if (!next) {
      break;
    }

  }

  console.log("");
  console.log(
    "⚫ 현재 방송 목록에서 내 채널을 찾지 못함"
  );
  console.log(
    "검색한 channelId:",
    channelId
  );
  console.log("");

  return null;
}
/* =========================================
   방송 세션 생성
========================================= */

function createBroadcastSession(
  req,
  liveInfo
) {

  const channelId =
    safeFileName(
      getChannelId(req)
    );

  const broadcastId =
    String(
      liveInfo?.liveId ||
      Date.now()
    );

  const broadcastDir =
    path.join(
      CHAT_DIR,
      channelId
    );

  if (!fs.existsSync(
    broadcastDir
  )) {

    fs.mkdirSync(
      broadcastDir,
      {
        recursive: true
      }
    );
  }

  const file =
    path.join(
      broadcastDir,
      `${broadcastId}.json`
    );

  /*
   * 같은 방송 파일이 이미 있으면
   * 기존 파일을 이어서 사용
   */

  if (fs.existsSync(file)) {

    try {

      const existing =
        JSON.parse(
          fs.readFileSync(
            file,
            "utf8"
          )
        );

      return {
        ...existing,
        file
      };

    } catch {
      // 파일이 깨졌으면 새로 생성
    }
  }

  const broadcast = {

    id:
      broadcastId,

    channelId,

    liveId:
      liveInfo?.liveId ||
      null,

    title:
      liveInfo?.liveTitle ||
      null,

    startedAt:
      Date.now(),

    endedAt:
      null,

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

  console.log("");
  console.log(
    "===== 방송 세션 생성 ====="
  );
  console.log(
    "방송 ID:",
    broadcastId
  );
  console.log(
    "방송 제목:",
    liveInfo?.liveTitle ||
    "(제목 없음)"
  );
  console.log(
    "저장 파일:",
    file
  );
  console.log(
    "=========================="
  );

  return {
    ...broadcast,
    file
  };
}

/* =========================================
   방송 채팅 저장
========================================= */

function saveBroadcastMessage(
  connection,
  chat
) {

  if (
    !connection ||
    !connection.broadcast
  ) {
    return;
  }

  const broadcast =
    connection.broadcast;

  if (!Array.isArray(
    broadcast.messages
  )) {
    broadcast.messages = [];
  }

  broadcast.messages.push(
    chat
  );

  try {

    fs.writeFileSync(
      broadcast.file,
      JSON.stringify(
        broadcast,
        null,
        2
      ),
      "utf8"
    );

  } catch (error) {

    console.error(
      "방송 채팅 저장 오류:",
      error
    );

  }
}

/* =========================================
   채팅 수집 시작
========================================= */

async function startChatCollection(
  req
) {

  if (!req.session.accessToken) {

    throw new Error(
      "치지직 로그인이 필요합니다."
    );
  }

  const channelId =
    getChannelId(req);

  if (!channelId) {

    throw new Error(
      "치지직 채널 ID를 확인할 수 없습니다."
    );
  }

  /*
   * 이미 연결되어 있으면
   * 중복 연결하지 않음
   */

  const existing =
    chatConnections.get(
      channelId
    );

  if (
    existing &&
    existing.collecting
  ) {

    console.log(
      "이미 채팅 수집 중:",
      channelId
    );

    return;
  }

  /*
   * 현재 방송 정보 확보
   */

  const live =
    await getCurrentLive(
      channelId
    );

  if (!live) {

    throw new Error(
      "현재 방송 중이 아닙니다."
    );
  }

  /*
   * 방송 세션 생성
   */

  const broadcast =
    createBroadcastSession(
      req,
      live
    );

  console.log("");
  console.log(
    "===== 채팅 수집 시작 ====="
  );
  console.log(
    "채널 ID:",
    channelId
  );
  console.log(
    "방송 ID:",
    live.liveId
  );

  /*
   * 치지직 채팅 클라이언트
   */

  const chatClient =
    new ChzzkChat({

      accessToken:
        req.session.accessToken,

      channelId,

      onChat: (
        chat
      ) => {

        console.log(
          "[후던챗]",
          chat.nickname,
          ":",
          chat.content
        );

        /*
         * 방송별 저장
         */

        const connection =
          chatConnections.get(
            channelId
          );

        saveBroadcastMessage(
          connection,
          chat
        );

        /*
         * 전체 채팅 저장
         */

        addMessages(
          req,
          [chat]
        );
      },

      onStatus: (
        message
      ) => {

        console.log(
          `[후던챗 ${channelId}]`,
          message
        );

      }

    });

  /*
   * 연결 정보 먼저 등록
   */

  chatConnections.set(
    channelId,
    {
      chatClient,
      collecting: true,
      broadcast,
      liveId:
        live.liveId
    }
  );

  try {

    await chatClient.connect();

    console.log(
      "✅ 실시간 채팅 연결 완료:",
      channelId
    );

  } catch (error) {

    chatConnections.delete(
      channelId
    );

    throw error;
  }
}

/* =========================================
   채팅 수집 중지
========================================= */

function stopChatCollection(
  req
) {

  const channelId =
    getChannelId(req);

  if (!channelId) {
    return;
  }

  const connection =
    chatConnections.get(
      channelId
    );

  if (!connection) {

    console.log(
      "실행 중인 채팅 연결이 없습니다:",
      channelId
    );

    return;
  }

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

  if (
    connection.broadcast
  ) {

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

  chatConnections.delete(
    channelId
  );

  console.log(
    "채팅 수집 중지:",
    channelId
  );
}

/* =========================================
   방송 감시
========================================= */

async function checkLiveWatcher(
  channelId
) {

  const watcher =
    liveWatchers.get(
      channelId
    );

  if (!watcher) {
    return;
  }

  try {

    const live =
      await getCurrentLive(
        channelId
      );

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

      watcher.isLive =
        true;

      watcher.liveId =
        live.liveId;

      watcher.liveInfo =
        live;

      /*
       * 자동 채팅 수집
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
          "❌ 방송 시작 후 채팅 수집 실패:",
          error.message
        );

      }
    }

    /*
     * 방송 중 정보 갱신
     */

    if (isLive) {

      watcher.isLive =
        true;

      watcher.liveId =
        live.liveId;

      watcher.liveInfo =
        live;

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

      watcher.isLive =
        false;

      watcher.liveId =
        null;

      watcher.liveInfo =
        null;
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

async function startLiveWatcher(
  req
) {

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
   * 기존 감시자가 있으면
   * 세션만 갱신
   */

  if (
    liveWatchers.has(
      channelId
    )
  ) {

    const watcher =
      liveWatchers.get(
        channelId
      );

    watcher.req =
      req;

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
   * 로그인 직후 즉시 확인
   */

  await checkLiveWatcher(
    channelId
  );

  /*
   * 10초마다 확인
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

function stopLiveWatcher(
  channelId
) {

  const watcher =
    liveWatchers.get(
      channelId
    );

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
   로그인
========================================= */

app.get(
  "/auth/login",
  (req, res) => {

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

          response_type:
            "code",

          clientId,

          redirectUri,

          state

        });

      const loginUrl =
        `https://chzzk.naver.com/account-interlock?${params.toString()}`;

      res.redirect(
        loginUrl
      );

    } catch (error) {

      console.error(
        "치지직 로그인 시작 오류:",
        error
      );

      res.status(500).send(
        `로그인 시작 실패: ${escapeHtml(error.message)}`
      );
    }
  }
);

/* =========================================
   로그인 콜백
========================================= */

app.get(
  "/auth/callback",
  async (req, res) => {

    try {

      const code =
        String(
          req.query.code || ""
        );

      const state =
        String(
          req.query.state || ""
        );

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
        state !==
          req.session.oauthState
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

      const response =
        await fetch(
          "https://openapi.chzzk.naver.com/auth/v1/token",
          {

            method:
              "POST",

            headers: {

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

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
          JSON.parse(
            tokenText
          );

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
        token.content ||
        token;

      if (!content.accessToken) {

        throw new Error(
          "accessToken을 받지 못했습니다."
        );
      }

      req.session.accessToken =
        content.accessToken;

      req.session.refreshToken =
        content.refreshToken ||
        null;

      delete req.session.oauthState;

      /*
       * 내 계정 정보
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

      if (!meResponse.ok) {

        throw new Error(
          meData.message ||
          "사용자 정보를 가져오지 못했습니다."
        );
      }

      const me =
        meData.content ||
        meData;

      /*
       * 중요:
       * channelId를 최우선으로 사용
       */

      req.session.channelId =
        me.channelId ||
        null;

      req.session.userId =
        me.userId ||
        me.id ||
        null;

      if (!req.session.channelId) {

        throw new Error(
          "치지직 channelId를 가져오지 못했습니다."
        );
      }

      console.log(
        "로그인 channelId:",
        req.session.channelId
      );

      /*
       * 방송 감시 시작
       */

      await startLiveWatcher(
        req
      );

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
<pre>${escapeHtml(
        error.message
      )}</pre>
<a href="/">후던챗으로 돌아가기</a>
</div>
</body>
</html>
      `);
    }
  }
);

/* =========================================
   내 계정
========================================= */

app.get(
  "/api/me",
  async (req, res) => {

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
        data.content ||
        data;

      req.session.channelId =
        me.channelId ||
        null;

      req.session.userId =
        me.userId ||
        me.id ||
        null;

      /*
       * 기존 세션이 있는데
       * 감시자가 없다면 다시 시작
       */

      if (
        req.session.channelId &&
        !liveWatchers.has(
          req.session.channelId
        )
      ) {

        await startLiveWatcher(
          req
        );
      }

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
  }
);

/* =========================================
   채팅 정보
========================================= */

app.get(
  "/api/chat/info",
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

      if (
        messages.length ===
        0
      ) {

        return res.json({

          count: 0,

          firstTimestamp:
            null,

          lastTimestamp:
            null

        });
      }

      const timestamps =
        messages
          .map(
            (message) =>
              Number(
                message.timestamp
              )
          )
          .filter(
            (timestamp) =>
              Number.isFinite(
                timestamp
              )
          );

      res.json({

        count:
          messages.length,

        firstTimestamp:
          timestamps.length
            ? Math.min(
                ...timestamps
              )
            : null,

        lastTimestamp:
          timestamps.length
            ? Math.max(
                ...timestamps
              )
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
  }
);

/* =========================================
   채팅 전체 조회
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
   채팅 저장 API
========================================= */

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

      if (!Array.isArray(
        incoming
      )) {

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
   채팅 삭제
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

      if (
        fs.existsSync(file)
      ) {

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
   방송 수집 시작 API
========================================= */

app.post(
  "/api/live/start",
  async (req, res) => {

    try {

      if (!req.session.accessToken) {

        return res.status(401).json({

          success: false,

          loggedIn: false,

          error:
            "치지직 로그인이 필요합니다."

        });
      }

      const channelId =
        getChannelId(req);

      if (!channelId) {

        return res.status(400).json({

          success: false,

          error:
            "채널 ID를 확인할 수 없습니다."

        });
      }

      /*
       * 현재 방송 확인
       */

      const live =
        await getCurrentLive(
          channelId
        );

      if (!live) {

        return res.status(400).json({

          success: false,

          collecting: false,

          isLive: false,

          error:
            "현재 방송 중이 아닙니다."

        });
      }

      /*
       * 감시자 정보 갱신
       */

      let watcher =
        liveWatchers.get(
          channelId
        );

      if (!watcher) {

        await startLiveWatcher(
          req
        );

        watcher =
          liveWatchers.get(
            channelId
          );

      }

      if (watcher) {

        watcher.req =
          req;

        watcher.isLive =
          true;

        watcher.liveId =
          live.liveId;

        watcher.liveInfo =
          live;

      }

      /*
       * 채팅 시작
       */

      await startChatCollection(
        req
      );

      res.json({

        success: true,

        collecting: true,

        isLive: true,

        live: {

          liveId:
            live.liveId ||
            null,

          title:
            live.liveTitle ||
            null,

          channelId:
            live.channelId ||
            channelId

        }

      });

    } catch (error) {

      console.error(
        "실시간 채팅 시작 오류:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "채팅 수집을 시작할 수 없습니다."

      });
    }
  }
);

/* =========================================
   방송 수집 중지 API
========================================= */

app.post(
  "/api/live/stop",
  (req, res) => {

    try {

      stopChatCollection(
        req
      );

      res.json({

        success: true,

        collecting: false

      });

    } catch (error) {

      console.error(
        "채팅 중지 오류:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "채팅 수집 중지에 실패했습니다."

      });
    }
  }
);

/* =========================================
   ⭐ 현재 방송 상태 API
========================================= */

app.get(
  "/api/live/status",
  async (req, res) => {

    try {

      /*
       * 로그인 확인
       */

      if (!req.session.accessToken) {

        return res.status(401).json({

          loggedIn: false,

          isLive: false,

          collecting: false,

          error:
            "로그인이 필요합니다."

        });
      }

      /*
       * channelId 확인
       */

      const channelId =
        getChannelId(req);

      if (!channelId) {

        return res.status(400).json({

          loggedIn: true,

          isLive: false,

          collecting: false,

          error:
            "채널 ID를 확인할 수 없습니다."

        });
      }

      /*
       * 현재 방송 확인
       */

      const live =
        await getCurrentLive(
          channelId
        );

      const isLive =
        !!live;

      /*
       * 채팅 연결 확인
       */

      const connection =
        chatConnections.get(
          channelId
        );

      const collecting =
        !!connection?.collecting;

      /*
       * 감시자 확인
       */

      const watcher =
        liveWatchers.get(
          channelId
        );

      /*
       * 방송 중이면 감시자 정보도
       * 최신 상태로 갱신
       */

      if (
        live &&
        watcher
      ) {

        watcher.isLive =
          true;

        watcher.liveId =
          live.liveId;

        watcher.liveInfo =
          live;

      }

      res.json({

        loggedIn: true,

        channelId,

        isLive,

        collecting,

        watcher:
          !!watcher,

        live:
          live
            ? {

                liveId:
                  live.liveId ||
                  null,

                title:
                  live.liveTitle ||
                  null,

                channelId:
                  live.channelId ||
                  channelId,

                channelName:
                  live.channelName ||
                  null,

                concurrentUserCount:
                  live.concurrentUserCount ||
                  0,

                openDate:
                  live.openDate ||
                  null

              }
            : null

      });

    } catch (error) {

      console.error(
        "방송 상태 조회 오류:",
        error
      );

      res.status(500).json({

        loggedIn: true,

        isLive: false,

        collecting: false,

        error:
          error.message ||
          "방송 상태를 확인할 수 없습니다."

      });
    }
  }
);

/* =========================================
   저장된 실시간 채팅
========================================= */

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

      const channelId =
        getChannelId(req);

      const connection =
        chatConnections.get(
          channelId
        );

      res.json({

        messages,

        count:
          messages.length,

        collecting:
          !!connection?.collecting

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

/* =========================================
   서버 실행
========================================= */

app.listen(
  PORT,
  () => {

    console.log("");

    console.log(
      "================================="
    );

    console.log(
      "후던챗 서버 실행 완료"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "채팅 저장 폴더:",
      CHAT_DIR
    );

    console.log(
      "방송 감시:",
      "10초"
    );

    console.log(
      "================================="
    );
  }
);