const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const USE_PROXY = true;
const proxy_host = "geo.iproyal.com";
const proxy_port = 12321;
const proxy_username = "kPMj8aoitK1MVa3e";
const proxy_password = "pookydooki_country-us";
const PROXY_URL = `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const app = express();
app.use(express.json());

app.post('/alaska', async (req, res) => {
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