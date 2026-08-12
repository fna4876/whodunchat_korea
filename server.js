/* 치지직 로그인 */

import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);

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

function randomState() {
  return crypto.randomBytes(24).toString("hex");
}

function escapeHtml(value) {
  return String(value).replace(
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

app.get("/auth/login", (req, res) => {
  try {
    const clientId = process.env.CHZZK_CLIENT_ID;
    const clientSecret = process.env.CHZZK_CLIENT_SECRET;

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

    const state = randomState();

    req.session.oauthState = state;

    const params = new URLSearchParams({
      response_type: "code",
      clientId: clientId,
      redirectUri: redirectUri,
      state: state
    });

    const loginUrl =
      `https://chzzk.naver.com/account-interlock?${params.toString()}`;

    console.log("");
    console.log("===== 치지직 로그인 시작 =====");
    console.log("clientId:", clientId);
    console.log("clientSecret 존재:", Boolean(clientSecret));
    console.log("redirectUri:", redirectUri);
    console.log("state 길이:", state.length);
    console.log("로그인 URL 생성 완료");
    console.log("==============================");

    res.redirect(loginUrl);

  } catch (error) {
    console.error("치지직 로그인 시작 오류:", error);

    res.status(500).send(
      `로그인 시작 실패: ${escapeHtml(error.message)}`
    );
  }
});


/* 치지직 로그인 콜백 */

app.get("/auth/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    console.log("");
    console.log("===== 치지직 로그인 콜백 =====");
    console.log("code 존재:", Boolean(code));
    console.log("state 존재:", Boolean(state));
    console.log(
      "저장된 state 존재:",
      Boolean(req.session.oauthState)
    );
    console.log(
      "state 일치:",
      state === req.session.oauthState
    );

    if (!code) {
      throw new Error(
        "치지직에서 authorization code를 받지 못했습니다."
      );
    }

    if (!state) {
      throw new Error(
        "치지직에서 state를 받지 못했습니다."
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

    const clientId = process.env.CHZZK_CLIENT_ID;
    const clientSecret = process.env.CHZZK_CLIENT_SECRET;

const redirectUri =
  process.env.CHZZK_REDIRECT_URI ||
   "http://localhost:" + PORT + "/auth/callback";

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

    console.log("clientId:", clientId);
    console.log(
      "clientSecret 존재:",
      Boolean(clientSecret)
    );
    console.log(
      "clientSecret 길이:",
      clientSecret.length
    );
    console.log("redirectUri:", redirectUri);
    console.log("code 길이:", code.length);
    console.log("state 길이:", state.length);

   const body = {
  grantType: "authorization_code",
  clientId: clientId,
  clientSecret: clientSecret,
  code: code,
  state: state
};

console.log("");
console.log("===== 치지직 토큰 요청 =====");
console.log(
  "token URL:",
  "https://openapi.chzzk.naver.com/auth/v1/token"
);
console.log("grantType:", body.grantType);
console.log("clientId 존재:", Boolean(body.clientId));
console.log("clientSecret 존재:", Boolean(body.clientSecret));
console.log("code 길이:", body.code?.length);
console.log("redirectUri:", redirectUri);
console.log("============================");

console.log("치지직 토큰 발급 요청 중...");

const response = await fetch(
  "https://openapi.chzzk.naver.com/auth/v1/token",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }
);

const tokenText = await response.text();

console.log(
  "치지직 토큰 응답 상태:",
  response.status
);

console.log(
  "치지직 토큰 응답:",
  tokenText
);

let token;

try {
  token = JSON.parse(tokenText);
} catch {
  throw new Error(
    "치지직 토큰 API 응답이 JSON이 아닙니다: " +
    tokenText
  );
}

if (!response.ok) {
  throw new Error(
    "토큰 발급 실패 (" +
      response.status +
      "): " +
      (
        token.message ||
        token.error ||
        JSON.stringify(token)
      )
  );
}

const content = token.content || token;

if (!content.accessToken) {
  throw new Error(
    "치지직에서 accessToken을 받지 못했습니다."
  );
}

req.session.accessToken = content.accessToken;
req.session.refreshToken =
  content.refreshToken || null;

delete req.session.oauthState;

console.log("");
console.log("===== 치지직 로그인 성공 =====");
console.log(
  "accessToken 존재:",
  Boolean(req.session.accessToken)
);
console.log("==============================");

res.redirect("/");

  } catch (error) {
    console.error("");
    console.error("===== 치지직 로그인 오류 =====");
    console.error(error);
    console.error("==============================");

    res.status(400).send(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>로그인 실패</title>

  <style>
    body {
      background: #080808;
      color: #eee;
      font-family: Arial, sans-serif;
      padding: 40px;
    }

    .box {
      max-width: 600px;
      margin: 80px auto;
      border: 1px solid #333;
      padding: 30px;
      background: #111;
      border-radius: 12px;
    }

    h2 {
      color: #ff6262;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      color: #aaa;
      line-height: 1.6;
    }

    a {
      display: inline-block;
      margin-top: 20px;
      color: #00d564;
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
app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.accessToken) {
      return res.json({
        loggedIn: false
      });
    }

    const response = await fetch(
      "https://openapi.chzzk.naver.com/open/v1/users/me",
      {
        headers: {
          Authorization:
            "Bearer " + req.session.accessToken
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.json({
        loggedIn: false,
        error: data.message || "치지직 API 오류"
      });
    }

    res.json({
      loggedIn: true,
      me: data.content || data
    });

  } catch (error) {
    console.error("내 계정 확인 오류:", error);

    res.json({
      loggedIn: false,
      error: error.message
    });
  }
});


app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("후던챗 서버 실행 완료");
  console.log("http://localhost:" + PORT);
  console.log("=================================");
});

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("후던챗 서버 실행 완료");
  console.log("http://localhost:" + PORT);
  console.log("=================================");
});