// Quick test of the date validation logic
const { differenceInDays, parseISO } = require('date-fns');

// Test the date validation logic with your example
const startDate = parseISO('2026-04-01');
const endDate = parseISO('2026-04-20');
const daysDifference = differenceInDays(endDate, startDate);

console.log('Test Case: SCL->EZE 2026-04-01 to 2026-04-20');
console.log('Start Date:', startDate.toISOString().split('T')[0]);
console.log('End Date:', endDate.toISOString().split('T')[0]);
console.log('Days Difference:', daysDifference);
console.log('Should be blocked (>2 days):', daysDifference > 2);
console.log('');

// Test valid cases (should pass)
console.log('Valid test cases (should pass):');

const validCases = [
  ['2026-04-01', '2026-04-01'], // Same day (0 days diff)
  ['2026-04-01', '2026-04-02'], // 1 day diff
  ['2026-04-01', '2026-04-03'], // 2 days diff
];

validCases.forEach(([start, end]) => {
  const s = parseISO(start);
  const e = parseISO(end);
  const diff = differenceInDays(e, s);
  console.log(`${start} to ${end}: ${diff} days (should pass: ${diff <= 2})`);
});

console.log('');
console.log('Invalid test cases (should be blocked):');

const invalidCases = [
  ['2026-04-01', '2026-04-04'], // 3 days diff
  ['2026-04-01', '2026-04-05'], // 4 days diff  
  ['2026-04-01', '2026-04-20'], // 19 days diff
];

invalidCases.forEach(([start, end]) => {
  const s = parseISO(start);
  const e = parseISO(end);
  const diff = differenceInDays(e, s);
  console.log(`${start} to ${end}: ${diff} days (should block: ${diff > 2})`);
});
