const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

const app = express();
app.use(express.json());

app.post('/alaska', async (req, res) => {
  // Proxy config (runtime only)
  const USE_PROXY = true;
  const proxy_host = process.env.PROXY_HOST;
  const proxy_port = process.env.PROXY_PORT;
  const proxy_username = process.env.PROXY_USERNAME;
  const proxy_password = process.env.PROXY_PASSWORD;
  if (USE_PROXY && (!proxy_host || !proxy_port || !proxy_username || !proxy_password)) {
    return res.status(500).json({ error: 'Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.' });
  }
  const PROXY_URL = USE_PROXY
    ? `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`
    : undefined;
  const proxyAgent = USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

  const { from, to, depart, ADT } = req.body;
  try {
    const params = new URLSearchParams({
      O: from,
      D: to,
      OD: depart,
      A: String(ADT),
      C: '0',
      L: '0',
      RT: 'false',
      ShoppingMethod: 'onlineaward',
    });
    const url = `https://www.alaskaair.com/search/results?${params.toString()}`;
    const fetchOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    };
    if (USE_PROXY) fetchOptions.agent = proxyAgent;
    const response = await fetch(url, fetchOptions);
    const html = await response.text();
    res.status(200).json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4001, () => console.log('Alaska microservice running on port 4001')); 