const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json());

const proxyAgent = new HttpsProxyAgent('http://kPMj8aoitK1MVa3e:pookydooki_country-us@geo.iproyal.com:12321');

app.post('/jetblue', async (req, res) => {
  const { from, to, depart, ADT } = req.body;
  try {
    const response = await fetch('https://jbrest.jetblue.com/lfs-rwb/outboundLFS', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'API-Version': 'v3',
        'Application-Channel': 'Desktop_Web',
        'Booking-Application-Type': 'NGB',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Referer': `https://www.jetblue.com/booking/flights?from=${from}&to=${to}&depart=${depart}&isMultiCity=false&noOfRoute=1&adults=${ADT}&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`,
        'X-B3-TraceId': '6aaca3c26c23f81c',
        'X-B3-SpanId': '1749578192171',
      },
      body: JSON.stringify({
        tripType: 'oneWay',
        from,
        to,
        depart,
        cabin: 'economy',
        refundable: false,
        dates: { before: '3', after: '3' },
        pax: { ADT, CHD: 0, INF: 0, UNN: 0 },
        redempoint: true,
        pointsBreakup: { option: '', value: 0 },
        isMultiCity: false,
        isDomestic: false,
        'outbound-source': 'fare-setSearchParameters',
      }),
      agent: proxyAgent,
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`JetBlue microservice running on port ${PORT}`);
}); 