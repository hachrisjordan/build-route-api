const { createClient } = require('@supabase/supabase-js');

// Test Supabase connection
async function testSupabaseConnection() {
  const supabaseUrl = 'https://dbaixrvzmfwhhbgyoebt.supabase.co';
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiYWl4cnZ6bWZ3aGhiZ3lvZWJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDgxOTMzOTcsImV4cCI6MjA2Mzc2OTM5N30.C4GNM4tEd2Ovxpb7eq3XFhL6dJj43lpputNk8-w8xGg';
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  try {
    // Test inserting a sample record
    const testData = {
      origin_airport_code: 'SIN',
      destination_airport_code: 'JFK',
      departure_date: '2025-10-12',
      miles: 111500,
      cabin_class: 'Business',
      fare_family: 'Saver',
      status: 'Available',
      week_number: 1
    };
    
    console.log('Testing Supabase connection...');
    const { data, error } = await supabase
      .from('sq')
      .insert([testData]);
    
    if (error) {
      console.error('❌ Error:', error.message);
      return false;
    }
    
    console.log('✅ Successfully connected to Supabase and inserted test data');
    
    // Verify the data was inserted
    const { data: verifyData, error: verifyError } = await supabase
      .from('sq')
      .select('*')
      .eq('origin_airport_code', 'SIN')
      .eq('destination_airport_code', 'JFK');
    
    if (verifyError) {
      console.error('❌ Error verifying data:', verifyError.message);
      return false;
    }
    
    console.log('✅ Data verification successful:', verifyData.length, 'records found');
    console.log('Sample record:', verifyData[0]);
    
    return true;
  } catch (error) {
    console.error('❌ Connection test failed:', error.message);
    return false;
  }
}

// Run the test
testSupabaseConnection().then(success => {
  if (success) {
    console.log('\n🎉 Supabase integration is working correctly!');
  } else {
    console.log('\n💥 Supabase integration failed. Please check your configuration.');
  }
  process.exit(success ? 0 : 1);
});
