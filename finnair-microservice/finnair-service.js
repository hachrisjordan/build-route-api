const express = require('express');
const fetch = require('node-fetch');
const compression = require('compression');

const app = express();
app.use(express.json());
app.use(compression());

// TEMPORARY: Hardcoded Bearer token for Finnair API
defaultBearerToken = 'Bearer VEdULTEzMjIyOC1qNkxCWk9OTDhZbWphWlUxM0J2WU14aFMwbEpQTzZQTjdIa3hwM2RtMFJZbm1lZ0UtMnVRb2l2aFZRaFhvZlpIbURNLWlwLTE3Mi0zMS0xMzAtMTA4';

app.post('/finnair', async (req, res) => {
  try {
    const body = req.body;
    // Validate required fields (minimal)
    if (!body || !body.itinerary || !body.adults) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const url = 'https://api.finnair.com/d/fcom/offers-prod/current/api/offerList';
    const fetchOptions = {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'authorization': defaultBearerToken,
        'connection': 'keep-alive',
        'content-type': 'application/json',
        'host': 'api.finnair.com',
        'origin': 'https://www.finnair.com',
        'referer': 'https://www.finnair.com/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': 'FinnairMobileAppApi/1.0',
        'x-client-id': 'MOBILEAPP_IOS',
        'x-dd-flow-type': 'award',
      },
      body: JSON.stringify(body),
    };
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Finnair API error', status: response.status, body: errorText });
    }
    const json = await response.json();
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4003, () => console.log('Finnair microservice running on port 4003')); 