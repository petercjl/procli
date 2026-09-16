import { CliError, readToken } from "./config.mjs";

export async function request(profile, pathname, options = {}) {
  const token = options.token === undefined ? await readToken(profile.name) : options.token;
  let response;
  try {
    response = await fetch(profile.url + pathname, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
      redirect: options.redirect || "follow",
    });
  } catch (error) {
    throw new CliError("SERVICE_UNAVAILABLE", `无法连接 Profile “${profile.name}”：${profile.url}`, {
      cause: error.name,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("INVALID_RESPONSE", `服务返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || payload.ok === false) {
    const upstream = payload?.error || {};
    throw new CliError(upstream.code || `HTTP_${response.status}`, upstream.message || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      profile: profile.name,
    });
  }
  return { status: response.status, data: payload.data };
}

export async function uploadRequest(profile, pathname, form, idempotencyKey) {
  const token = await readToken(profile.name);
  let response;
  try {
    response = await fetch(profile.url + pathname, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    throw new CliError("SERVICE_UNAVAILABLE", `无法上传到 Profile “${profile.name}”`,
      { cause: error.name });
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new CliError("INVALID_RESPONSE", `上传返回非 JSON（HTTP ${response.status}）`); }
  if (!response.ok || payload.ok === false)
    throw new CliError(payload.error?.code || `HTTP_${response.status}`,
      payload.error?.message || "上传失败", { status: response.status });
  return { status: response.status, data: payload.data };
}

export async function inspectTarget(profile) {
  const { data } = await request(profile, "/api/health", { token: "" });
  const target = {
    profile: profile.name,
    url: profile.url,
    environment: data.environment || "unknown",
    instanceId: data.instanceId || "unknown",
    apiVersion: data.apiVersion || "unknown",
    commit: data.commit || "unknown",
  };
  if (profile.environment && target.environment !== profile.environment)
    throw new CliError("TARGET_MISMATCH", "Profile 环境与服务端环境不一致", {
      expected: profile.environment,
      actual: target.environment,
      profile: profile.name,
    });
  if (profile.instanceId && target.instanceId !== profile.instanceId)
    throw new CliError("TARGET_MISMATCH", "Profile 实例指纹与服务端不一致", {
      expected: profile.instanceId,
      actual: target.instanceId,
      profile: profile.name,
    });
  if (String(target.apiVersion) !== "1")
    throw new CliError("API_VERSION_UNSUPPORTED", `服务端 API 版本不受支持：${target.apiVersion}`);
  return target;
}
