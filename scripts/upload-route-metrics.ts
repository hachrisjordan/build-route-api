import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

/**
 * Upload route_count.csv to Supabase route_metrics table
 * Sets day_count = 1 for existing data and calculates avg = count / day_count
 */
async function uploadRouteMetrics() {
  const csvPath = path.join(process.cwd(), 'csv-output', 'route_count.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`📖 Reading CSV file: ${csvPath}`);
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = csvContent.split('\n').slice(1); // Skip header

  const records: Array<{ origin: string; destination: string; count: number; day_count: number }> = [];
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [origin, destination, countStr] = trimmed.split(',');
    
    if (!origin || !destination || !countStr) {
      skipped++;
      continue;
    }

    const count = parseInt(countStr, 10);
    if (isNaN(count)) {
      skipped++;
      continue;
    }

    const day_count = 1; // Default for existing CSV data
    // avg is computed automatically by the database (GENERATED ALWAYS column)

    records.push({
      origin: origin.trim(),
      destination: destination.trim(),
      count,
      day_count
    });
  }

  console.log(`✅ Parsed ${records.length} records (skipped ${skipped} invalid lines)`);

  // Get Supabase admin client
  const supabase = getSupabaseAdminClient();

  // Upload in batches to avoid hitting limits
  const batchSize = 1000;
  let uploaded = 0;
  let errors = 0;

  console.log(`📤 Uploading ${records.length} records in batches of ${batchSize}...`);

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    try {
      const { error } = await supabase
        .from('route_metrics')
        .upsert(batch, {
          onConflict: 'origin,destination',
          ignoreDuplicates: false
        });

      if (error) {
        console.error(`❌ Error uploading batch ${Math.floor(i / batchSize) + 1}:`, error.message);
        errors += batch.length;
      } else {
        uploaded += batch.length;
        console.log(`✅ Uploaded batch ${Math.floor(i / batchSize) + 1}: ${batch.length} records (${uploaded}/${records.length} total)`);
      }
    } catch (err) {
      console.error(`❌ Exception uploading batch ${Math.floor(i / batchSize) + 1}:`, err);
      errors += batch.length;
    }
  }

  console.log(`\n📊 Upload Summary:`);
  console.log(`   ✅ Successfully uploaded: ${uploaded} records`);
  console.log(`   ❌ Errors: ${errors} records`);
  console.log(`   📝 Total processed: ${records.length} records`);
}

// Run the upload
uploadRouteMetrics()
  .then(() => {
    console.log('\n✅ Upload completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Upload failed:', error);
    process.exit(1);
  });

