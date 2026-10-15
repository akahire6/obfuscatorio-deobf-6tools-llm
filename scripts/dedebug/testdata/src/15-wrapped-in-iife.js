// プログラム全体が IIFE で包まれている形。
// 起動 IIFE を「一番外側」で探すと、プログラム全体を消しにいってしまう。
// 「一番内側」を採っていることの検査になる。
(function () {
  var items = ['alpha', 'beta', 'gamma'];
  function label(s, i) {
    return i + ':' + s.toUpperCase();
  }
  var out = [];
  for (var i = 0; i < items.length; i++) {
    out.push(label(items[i], i));
  }
  console.log(out.join(','));
}());
