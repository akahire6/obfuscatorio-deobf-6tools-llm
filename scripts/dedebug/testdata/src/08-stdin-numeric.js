// 標準入力から数値を読む典型形（process.stdin のイベント経由）
process.stdin.resume();
process.stdin.setEncoding('utf8');

let buffer = '';
process.stdin.on('data', function (chunk) {
  buffer += chunk;
});

process.stdin.on('end', function () {
  const lines = buffer.trim().split('\n');
  const n = parseInt(lines[0], 10);
  const nums = lines[1].split(' ').map(Number);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += nums[i];
  }
  console.log('n=' + n);
  console.log('sum=' + total);
  console.log('max=' + Math.max.apply(null, nums));
  console.log('sorted=' + nums.slice().sort((a, b) => a - b).join(' '));
});
