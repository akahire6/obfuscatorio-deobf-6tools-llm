// 文字列がごく少ないプログラム（string array が短くなる境界）
function fib(n) {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return a;
}

let acc = 0;
for (let i = 0; i < 20; i++) {
  acc += fib(i);
}
console.log(acc);
console.log(fib(30));
