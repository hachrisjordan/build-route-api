import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    console.log('[Tokens API] Fetching tokens from database...');
    
    const { data, error } = await supabase
      .from('token')
      .select('token');

    if (error) {
      console.error('[Tokens API] Database error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch tokens', message: error.message },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      console.error('[Tokens API] No tokens found in database');
      return NextResponse.json(
        { error: 'No tokens found in database' },
        { status: 404 }
      );
    }

    const tokens = data.map(row => row.token);
    console.log(`[Tokens API] Successfully fetched ${tokens.length} tokens`);
    
    return NextResponse.json({ tokens });
    
  } catch (error) {
    console.error('[Tokens API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
