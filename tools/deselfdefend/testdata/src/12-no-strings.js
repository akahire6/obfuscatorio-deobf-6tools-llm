// 文字列リテラルが実質存在しないプログラム（string array が作られない可能性がある入力）
let total = 0;
for (let i = 1; i <= 100; i++) {
  if (i % 3 === 0 || i % 5 === 0) {
    total += i;
  }
}
console.log(total);

const grid = [];
for (let y = 0; y < 4; y++) {
  const row = [];
  for (let x = 0; x < 4; x++) {
    row.push((x + 1) * (y + 1));
  }
  grid.push(row);
}
console.log(grid.map(r => r.reduce((a, b) => a + b, 0)));
