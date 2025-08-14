import { NextRequest, NextResponse } from 'next/server';
import { 
  testAdminConnection, 
  getAvailableProKey, 
  getAllProKeys 
} from '@/lib/supabase-admin';

/**
 * GET /api/admin/test-pro-key-access
 * Test endpoint to verify admin client can access pro_key table
 * This endpoint will help verify that:
 * 1. Admin client can connect to Supabase
 * 2. Admin client can read from pro_key table
 * 3. RLS is properly configured (blocks public access but allows service role)
 */
export async function GET(req: NextRequest) {
  try {
    console.log('[admin-test] Starting pro_key access test...');
    console.log('[admin-test] Environment check...');
    console.log('[admin-test] NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL ? 'SET' : 'MISSING');
    console.log('[admin-test] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');
    
    // Test 1: Basic connection test
    console.log('[admin-test] Testing admin connection...');
    const connectionTest = await testAdminConnection();
    
    if (!connectionTest) {
      return NextResponse.json({
        success: false,
        error: 'Admin client connection failed',
        tests: {
          connection: false,
          getAvailable: false,
          getAll: false
        }
      }, { status: 500 });
    }
    
    console.log('[admin-test] Connection test passed ✅');
    
    // Test 2: Get available pro_key
    console.log('[admin-test] Testing getAvailableProKey...');
    let availableProKey = null;
    let getAvailableError = null;
    
    try {
      availableProKey = await getAvailableProKey();
      console.log('[admin-test] getAvailableProKey passed ✅');
    } catch (error) {
      getAvailableError = error;
      console.error('[admin-test] getAvailableProKey failed ❌:', error);
    }
    
    // Test 3: Get all pro_keys
    console.log('[admin-test] Testing getAllProKeys...');
    let allProKeys = null;
    let getAllError = null;
    
    try {
      allProKeys = await getAllProKeys();
      console.log('[admin-test] getAllProKeys passed ✅');
    } catch (error) {
      getAllError = error;
      console.error('[admin-test] getAllProKeys failed ❌:', error);
    }
    
    // Prepare response
    const results = {
      success: true,
      message: "Admin client test completed",
      timestamp: new Date().toISOString(),
      adminTests: {
        connection: connectionTest,
        getAvailable: !getAvailableError,
        getAll: !getAllError
      },
      adminData: {
        availableProKey: availableProKey ? {
          pro_key: availableProKey.pro_key,
          remaining: availableProKey.remaining,
          lastUpdated: availableProKey.last_updated
        } : null,
        totalProKeys: allProKeys?.length || 0,
        allProKeys: allProKeys || []
      },
      adminErrors: {
        getAvailable: getAvailableError?.message || null,
        getAll: getAllError?.message || null
      }
    };
    
    console.log('[admin-test] Test completed successfully ✅');
    
    return NextResponse.json(results);
    
  } catch (error) {
    console.error('[admin-test] Unexpected error during testing:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Unexpected error during admin client testing',
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}

/**
 * POST /api/admin/test-pro-key-access
 * Test endpoint that attempts to access pro_key table using regular client
 * This should FAIL if RLS is properly configured
 * This demonstrates the security difference between admin and public access
 */
export async function POST(req: NextRequest) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const { getSanitizedEnv } = await import('@/lib/env-utils');
    
    console.log('[admin-test] Testing public client access (should fail)...');
    
    // Try to access with anon key (should fail with RLS)
    const supabaseUrl = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL');
    const supabaseAnonKey = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({
        success: false,
        error: 'Missing Supabase environment variables for public test'
      }, { status: 500 });
    }
    
    const publicClient = createClient(supabaseUrl, supabaseAnonKey);
    
    let publicAccessError = null;
    let publicAccessSuccess = false;
    
    try {
      const { data, error } = await publicClient
        .from('pro_key')
        .select('count', { count: 'exact', head: true });
      
      if (error) {
        publicAccessError = error.message;
        console.log('[admin-test] Public access blocked as expected ✅:', error.message);
      } else {
        publicAccessSuccess = true;
        console.warn('[admin-test] WARNING: Public access succeeded (RLS may not be working) ⚠️');
      }
    } catch (error) {
      publicAccessError = error instanceof Error ? error.message : 'Unknown error';
      console.log('[admin-test] Public access blocked as expected ✅');
    }
    
    return NextResponse.json({
      success: true,
      message: 'Public access test completed',
      timestamp: new Date().toISOString(),
      publicAccess: {
        succeeded: publicAccessSuccess,
        blocked: !publicAccessSuccess,
        error: publicAccessError
      },
      security: {
        rlsWorking: !publicAccessSuccess,
        recommendation: publicAccessSuccess 
          ? 'URGENT: Enable RLS on pro_key table to block public access'
          : 'Good: Public access is properly blocked by RLS'
      }
    });
    
  } catch (error) {
    console.error('[admin-test] Error during public access test:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Error during public access test',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
