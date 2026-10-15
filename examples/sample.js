// Grade report: average score and letter grade per student
const students = [
  { name: 'Aoi', scores: [78, 92, 85] },
  { name: 'Ren', scores: [55, 61, 70] },
  { name: 'Mio', scores: [98, 95, 100] },
  { name: 'Sota', scores: [40, 52, 38] },
];

function average(values) {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
}

function letterGrade(avg) {
  if (avg >= 90) return 'A';
  if (avg >= 75) return 'B';
  if (avg >= 60) return 'C';
  return 'F';
}

const report = students.map((student) => {
  const avg = average(student.scores);
  return { name: student.name, avg: avg.toFixed(1), grade: letterGrade(avg) };
});

for (const row of report) {
  console.log(`${row.name}: ${row.avg} (${row.grade})`);
}
const passed = report.filter((row) => row.grade !== 'F').length;
console.log('passed ' + passed + ' / ' + report.length);
