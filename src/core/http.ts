import * as http from "http";

export function checkHttpHealth(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 301);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
