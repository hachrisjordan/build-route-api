require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(compression());

// Supabase config from environment variables
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.post('/finnair', async (req, res) => {
  try {
    const body = req.body;
    // Validate required fields (minimal)
    if (!body || !body.itinerary || !body.adults) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Query Supabase for the token where code = 'AY'
    const { data, error } = await supabase
      .from('program')
      .select('token')
      .eq('code', 'AY')
      .single();

    if (error || !data || !data.token) {
      return res.status(500).json({ error: 'Failed to fetch Finnair token from Supabase', details: error?.message });
    }

    const bearerToken = data.token; // Use as-is, do NOT add "Bearer " again
    const url = 'https://api.finnair.com/d/fcom/offers-prod/current/api/offerList';
    const fetchOptions = {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'authorization': bearerToken,
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