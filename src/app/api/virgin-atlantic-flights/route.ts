import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '@/lib/env-utils';

// Use environment variables for Supabase
const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

/**
 * GET /api/virgin-atlantic-flights
 * Retrieve stored Virgin Atlantic flights from database
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Get query parameters
    const { searchParams } = new URL(req.url);
    const origin = searchParams.get('origin');
    const destination = searchParams.get('destination');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');
    const days = parseInt(searchParams.get('days') || '7');

    // Build query
    let query = supabase
      .from('virgin_atlantic_flights')
      .select('*')
      .gte('search_date', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Add filters if provided
    if (origin) {
      query = query.eq('origin_airport', origin);
    }
    if (destination) {
      query = query.eq('destination_airport', destination);
    }

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ 
        error: 'Database error', 
        details: error.message 
      }, { status: 500 });
    }

    return NextResponse.json({
      flights: data || [],
      metadata: {
        total: count || 0,
        limit,
        offset,
        days,
        filters: {
          origin,
          destination
        }
      }
    });

  } catch (error: any) {
    console.error('Error in /api/virgin-atlantic-flights:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 