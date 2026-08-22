#!/usr/bin/env node

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "copy_manga.js");
const comicId = process.argv[2] || "grandblue";
const epId = process.argv[3] || null;
const data = {};

class ComicSource {
  loadData(key) {
    return data[key];
  }

  saveData(key, value) {
    data[key] = value;
  }

  deleteData(key) {
    delete data[key];
  }

  loadSetting(key) {
    return data.settings?.[key] ?? this.settings?.[key]?.default;
  }
}

const Convert = {
  encodeUtf8(value) {
    return Buffer.from(value, "utf8");
  },

  decodeUtf8(value) {
    return Buffer.from(value).toString("utf8");
  },

  encodeBase64(value) {
    return Buffer.from(value).toString("base64");
  },

  decodeBase64(value) {
    return Buffer.from(value, "base64");
  },

  hmacString(key, value, hash) {
    return crypto.createHmac(hash, Buffer.from(key)).update(Buffer.from(value)).digest("hex");
  },

  decryptAesCbc(value, key, iv) {
    const decipher = crypto.createDecipheriv(
      `aes-${Buffer.from(key).length * 8}-cbc`,
      Buffer.from(key),
      Buffer.from(iv)
    );
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(Buffer.from(value)), decipher.final()]);
  },
};

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function send(method, url, headers = {}, body = null) {
  const response = sendWithPowerShell(method, url, headers, body);
  const text = response.body;
  console.log(`${method} ${url} -> ${response.status}`);
  if (response.status !== 200) {
    console.log(text.slice(0, 1000));
  }
  return {
    status: response.status,
    headers: response.headers,
    body: text,
  };
}

function sendWithPowerShell(method, url, headers = {}, body = null) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($env:HTTP_METHOD), $env:HTTP_URL)
$headers = ConvertFrom-Json $env:HTTP_HEADERS
foreach ($header in $headers.PSObject.Properties) {
  [void]$request.Headers.TryAddWithoutValidation($header.Name, [string]$header.Value)
}
if ($env:HTTP_BODY -ne '') {
  $request.Content = [System.Net.Http.StringContent]::new($env:HTTP_BODY, [System.Text.Encoding]::UTF8)
}
$response = $client.SendAsync($request).GetAwaiter().GetResult()
$responseHeaders = @{}
foreach ($header in $response.Headers) {
  $responseHeaders[$header.Key] = [string]::Join(',', $header.Value)
}
foreach ($header in $response.Content.Headers) {
  $responseHeaders[$header.Key] = [string]::Join(',', $header.Value)
}
$responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
[pscustomobject]@{
  status = [int]$response.StatusCode
  headers = $responseHeaders
  body = $responseBody
} | ConvertTo-Json -Depth 8 -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HTTP_METHOD: method,
        HTTP_URL: url,
        HTTP_HEADERS: JSON.stringify(headers || {}),
        HTTP_BODY: body == null ? "" : String(body),
      },
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    console.log(`${method} ${url} -> request failed`);
    console.log(result.stderr || result.stdout);
    throw new Error(`PowerShell HTTP request failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

async function fetchShim(url, options = {}) {
  const response = await send(options.method || "GET", url, options.headers || {}, options.body ?? null);
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: "",
    headers: response.headers,
    text: async () => response.body,
    json: async () => JSON.parse(response.body),
    arrayBuffer: async () => Buffer.from(response.body, "utf8"),
  };
}

const Network = {
  get(url, headers) {
    return send("GET", url, headers);
  },

  post(url, headers, body) {
    return send("POST", url, headers, body);
  },
};

const context = {
  APP: {
    version: "1.6.0",
    locale: "zh_CN",
    platform: "windows",
  },
  ComicSource,
  Convert,
  Network,
  UI: {
    showMessage(message) {
      console.log(`UI.showMessage: ${message}`);
    },
    showDialog(title, content) {
      console.log(`UI.showDialog: ${title}\n${content}`);
    },
  },
  console,
  fetch: fetchShim,
  randomInt,
  setTimeout,
};

async function main() {
  const sourceCode = fs.readFileSync(sourcePath, "utf8");
  vm.createContext(context);
  vm.runInContext(`${sourceCode}\nglobalThis.source = new CopyManga();`, context, {
    filename: "copy_manga.js",
  });

  const source = context.source;
  console.log(`Source version: ${source.version}`);
  console.log(`Comic id: ${comicId}`);

  if (typeof source.refreshAppApi === "function") {
    await source.refreshAppApi();
    console.log(`API host: ${source.apiHost}`);
  }

  console.log("\n== loadInfo ==");
  const info = await source.comic.loadInfo(comicId);
  const groups = info.chapters && typeof info.chapters.entries === "function"
    ? [...info.chapters.entries()].map(([name, chapters]) => ({
        name,
        count: chapters && typeof chapters.size === "number" ? chapters.size : undefined,
        first: chapters && typeof chapters.entries === "function" ? [...chapters.entries()][0] : undefined,
      }))
    : Object.keys(info.chapters ?? {});
  console.log({
    title: info.title,
    cover: info.cover,
    groups,
    isFavorite: info.isFavorite,
  });

  if (epId) {
    console.log("\n== loadEp ==");
    const ep = await source.comic.loadEp(comicId, epId);
    console.log({
      imageCount: ep.images.length,
      firstImage: ep.images[0],
    });
  }
}

main().catch((error) => {
  console.error("\nFAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
