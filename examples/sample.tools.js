const students = [
    {
        'name': 'Aoi',
        'scores': [
            0x4e,
            0x5c,
            0x55
        ]
    },
    {
        'name': 'Ren',
        'scores': [
            0x37,
            0x3d,
            0x46
        ]
    },
    {
        'name': 'Mio',
        'scores': [
            0x62,
            0x5f,
            0x64
        ]
    },
    {
        'name': 'Sota',
        'scores': [
            0x28,
            0x34,
            0x26
        ]
    }
];
function average(_0x399358) {
    let _0x2a13eb = 0x0;
    for (const _0x2531b4 of _0x399358) {
        _0x2a13eb += _0x2531b4;
    }
    return _0x2a13eb / _0x399358['length'];
}
function letterGrade(_0x405706) {
    if (_0x405706 >= 0x5a)
        return 'A';
    if (_0x405706 >= 0x4b)
        return 'B';
    if (_0x405706 >= 0x3c)
        return 'C';
    return 'F';
}
const report = students['map'](_0x182c28 => {
    const _0x59e144 = average(_0x182c28['scores']);
    return {
        'name': _0x182c28['name'],
        'avg': _0x59e144['toFixed'](0x1),
        'grade': letterGrade(_0x59e144)
    };
});
for (const row of report) {
    console['log'](row['name'] + ':\x20' + row['avg'] + '\x20(' + row['grade'] + ')');
}
const passed = report['filter'](_0x509279 => _0x509279['grade'] !== 'F')['length'];
console['log']('passed ' + passed + '\x20/\x20' + report['length']);