export async function getTeacherCsrfToken(runtime, cookie) {
  const response = await runtime.fetch(new Request("https://example.test/teacher", {
    headers: { Cookie: cookie }
  }));
  const html = await response.text();
  const match = html.match(/name="csrfToken"\s+value="([^"]+)"/);
  return match ? match[1] : "";
}

export async function followTeacherForm(runtime, path, body, cookie = "") {
  const payload = { ...body };
  if (cookie && path !== "/teacher/dev-login" && !payload.csrfToken) {
    payload.csrfToken = await getTeacherCsrfToken(runtime, cookie);
  }

  const response = await runtime.fetch(new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: new URLSearchParams(payload).toString(),
    redirect: "manual"
  }));
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  const cookieHeader = setCookie
    .map((item) => String(item).split(";")[0])
    .filter(Boolean)
    .join("; ");
  return { response, cookieHeader };
}
