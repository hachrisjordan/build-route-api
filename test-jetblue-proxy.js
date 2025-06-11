const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyAgent = new HttpsProxyAgent('http://kPMj8aoitK1MVa3e:pookydooki_country-us@geo.iproyal.com:12321');

fetch('https://jbrest.jetblue.com/lfs-rwb/outboundLFS', {
  method: 'POST',
  headers: {
    'X-B3-SpanId': '1749578192171',
    'sec-ch-ua-platform': '"Windows"',
    'Referer': 'https://www.jetblue.com/booking/flights?from=ORD&to=BKK&depart=2025-07-01&isMultiCity=false&noOfRoute=1&adults=1&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true',
    'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    'API-Version': 'v3',
    'Booking-Application-Type': 'NGB',
    'sec-ch-ua-mobile': '?0',
    'Application-Channel': 'Desktop_Web',
    'X-B3-TraceId': '6aaca3c26c23f81c',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tripType: 'oneWay',
    from: 'ORD',
    to: 'BKK',
    depart: '2025-07-01',
    cabin: 'economy',
    refundable: false,
    dates: { before: '3', after: '3' },
    pax: { ADT: 1, CHD: 0, INF: 0, UNN: 0 },
    redempoint: true,
    pointsBreakup: { option: '', value: 0 },
    isMultiCity: false,
    isDomestic: false,
    'outbound-source': 'fare-setSearchParameters',
  }),
  agent: proxyAgent,
})
  .then(res => res.text().then(text => console.log(res.status, text)))
  .catch(console.error); 