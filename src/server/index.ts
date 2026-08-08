import { config as loadDotenv } from "dotenv";

// 先加载 .env（若存在），再读取配置
loadDotenv();

const { loadConfig } = await import("./config.js");
const { createDatabase } = await import("./db.js");
const { buildApp } = await import("./app.js");

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  const app = await buildApp({ config, db });

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`agent-observe listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
