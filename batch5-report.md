# 第5批角色包报告

新增 16 个角色包，补全现有 hyunjin 目录，未新增重复 id。

| id | 姓名 | 出生日期（模型常识） | 2026-11 判定 | 严格模式 |
| --- | --- | --- | --- | --- |
| leeknow | 李旻浩 | 1998-10-25 | 成年 | 否 |
| felix | 李龙馥 | 2000-09-15 | 成年 | 否 |
| hyunjin | 黄铉辰 | 2000-03-20 | 成年 | 否 |
| bangchan | 方灿 | 1997-10-03 | 成年 | 否 |
| han | 韩知城 | 2000-09-14 | 成年 | 否 |
| sana | 凑崎纱夏 | 1996-12-29 | 成年 | 否 |
| nayeon | 林娜琏 | 1995-09-22 | 成年 | 否 |
| jennie | 金智妮 | 1996-01-16 | 成年 | 否 |
| lisa | 莉莎 | 1997-03-27 | 成年 | 否 |
| jisoo | 金智秀 | 1995-01-03 | 成年 | 否 |
| rose | 朴彩英 | 1997-02-11 | 成年 | 否 |
| ahyeon | 郑雅贤 | 2007-04-11 | 成年 | 否 |
| iu | 李知恩 | 1993-05-16 | 成年 | 否 |
| yujin | 安宥真 | 2003-09-01 | 成年 | 否 |
| wonyoung | 张元英 | 2004-08-31 | 成年 | 否 |
| rei | 直井怜 | 2004-02-03 | 成年 | 否 |
| liz | 金志垣 | 2004-11-21 | 成年 | 否 |

年龄判定依据：对以上出生日期有把握，均于 2026 年 11 月前满 18 岁；本次未上网，日期与公开资料整体待人工核验。ageVerified 是现有策略的成年开关，不代表已完成外部资料核验。没有本批严格模式角色。既有 CORTIS 等角色年龄策略未改动。

每包包含 manifest 列出的 8 个必填文件、原创首字配色 avatar.svg/portrait.svg、voice/prepare.js、voice/voice.lock.json，并配套 test/fixtures/voice/<id>.json。语音锁通过 lib/voice-pack.contentHash 计算，voiceId 留空，按性别使用 placeholderVoices 配置位，pins:[]、tags:keep。

人物说话节奏、兴趣切入点及四阶段表达分别创作；facts/sources 标注模型常识与待人工核验，动态标注虚构日常。全部 available:false，标签“暂未开放”，沿用现有前端禁用与服务端 requireAvailable 中间件。

其他改动：picker 公司映射增加 STARSHIP/EDAM；更新既有语音测试包数 62→79，移除 hyunjin“没有语音包”的旧断言；新增第5批离线角色包与实际路由中间件回归测试。伯贤、Kai、Mark 的角色与运行逻辑未修改。

离线检查：
- 10 个测试文件运行通过：第1至5批角色测试、prompt-pack、layers、account-cache、account-scope、memory-cards。
- 第5批测试覆盖资料字段、成年策略、SVG、语音锁与 fixture，以及直接调用实际 chat/TTS 路由的 requireAvailable，未监听端口。
- 21 个 JavaScript 文件 node --check 通过。
- 102 个包顶层 JSON 解析、17 个语音哈希、68 个分档提示词组装通过。
- git diff --check 通过。

执行中环境没有 python 命令，改用 python3 完成生成。Node 内 spawnSync 被 EPERM 阻止，改由 shell 逐个运行 node --check，全部成功。

未完成项：公开资料仍待人工核验；全量 npm test 按要求留给外部执行，未运行需 listen 的接口测试。未联网、未下载图片、未执行 git add/commit/push、未写入密钥。
