# 第2批 HYBE 一交付报告

## 新增与补全

新增15个目录：sunghoon、niki、sunoo、jungwon、taehyung、yeonjun、soobin、beomgyu、taehyun、hueningkai、martin、james、juhoon、seonghyeon、keonho。

补全既有占位2个：jimin、jungkook，沿用原 id。未改动 gdragon、hyunjin。

每人均有 manifest 所列八个必填文件、原创姓名首字 avatar.svg / portrait.svg、voice/voice.lock.json、voice/prepare.js 和 test/fixtures/voice/<id>.json。没有使用照片或下载素材；17人使用不同配色。公司按本批指定填写为 BELIFT LAB / HYBE 或 BIGHIT MUSIC / HYBE，来源仍标待人工核验。

## 年龄判定

按2026年11月判断；成年日期基于有把握的模型常识，未经联网或人工查证。ageVerified 在本项目中用于允许成年档位，不表示资料已经人工核验。事实与来源文件均保留“待人工核验”。CORTIS不推测出生日期，不将任何一人标成已经核实的未成年人。

| id | 中文名 | 出生日期（模型常识） | 本批判定 |
| --- | --- | --- | --- |
| sunghoon | 朴成训 | 2002-12-08 | 成年，四档 |
| niki | 西村力 | 2005-12-09 | 成年，四档 |
| sunoo | 金善禹 | 2003-06-24 | 成年，四档 |
| jungwon | 梁祯元 | 2004-02-09 | 成年，四档 |
| jimin | 朴智旻 | 1995-10-13 | 成年，四档 |
| jungkook | 田柾国 | 1997-09-01 | 成年，四档 |
| taehyung | 金泰亨 | 1995-12-30 | 成年，四档 |
| yeonjun | 崔然竣 | 1999-09-13 | 成年，四档 |
| soobin | 崔秀彬 | 2000-12-05 | 成年，四档 |
| beomgyu | 崔杋圭 | 2001-03-13 | 成年，四档 |
| taehyun | 姜太显 | 2002-02-05 | 成年，四档 |
| hueningkai | 休宁凯 | 2002-08-14 | 成年，四档 |
| martin | 马丁 | 未核实 | 严格模式，朋友式，最高close |
| james | 赵雨凡 | 未核实 | 严格模式，朋友式，最高close |
| juhoon | 金主训 | 未核实 | 严格模式，朋友式，最高close |
| seonghyeon | 严成玹 | 未核实 | 严格模式，朋友式，最高close |
| keonho | 安乾镐 | 未核实 | 严格模式，朋友式，最高close |

CORTIS：birthDate:null、ageVerified:false、minor:null，allowedTiers只含stranger/friend/close。persona不包含flirty档，所有档位仅朋友式，不含恋爱或性化指向。

## 全局与文件改动

- 开始工作时 lib/character-pack.js、lib/characters.js、public/shell/picker.js 已有未提交的八文件校验与开放标签机制，予以保留并沿用。服务端现有 requireAvailable 已拦截聊天、TTS、场景等接口，无需改写 server.js。
- 本批17人与第1批10人均 available:false、availabilityLabel:暂未开放。列表仍可见；选爱豆页按钮禁用并显示暂未开放。新增 BELIFT LAB / BIGHIT MUSIC 的公司标签显示文字。
- 第1批 sehun、the8、jun、renjun、ningning、yuqi、shuhua、tzuyu、jacksonwang、layzhang 的 persona 四档重写，保留原性格与表达特点。stranger温暖接应援/我爱你、想你、比心；friend逗趣闹小别扭；close关心、轻微吃醋、虚构双人约会；flirty各自不同的告白式心动。世勋保持短句与冷静语气。
- lib/build-prompt.js 在严格模式下改用朋友式公共档位正文，避免公共档位中恋爱/约会示例进入CORTIS提示词。最高优先级年龄规则仍保留；成年分支不变。
- 语音均为 <id>-placeholder-voice-1、pins:[]、tags:keep、voiceId空字符串、placeholderVoice:male，沿用配置 placeholderVoices.male；没有写入语音密钥或真实声音配置。contentHash用 lib/voice-pack.contentHash 计算，并生成对应 fixture。
- 新增 test/hybe-batch2.test.js：27人列表及状态、元数据、17人原创SVG及独立颜色、语音锁和fixture、年龄分档、严格提示词、每个必填文件未列入/实体缺失的离线校验，以及实际聊天/TTS路由的中间件拒绝验证（不监听端口）。
- test/helpers/complete-pack.js 补齐旧测试合成包；同步更新 prompt-pack、layers、isolation、第1批纯测试与API测试。voice-pack测试调整包总数至28，jimin/jungkook从无语音包占位断言中移出。
- 第1批API测试新增27人 /api/characters 可见且关闭、/api/chat与/api/tts拒绝，并验证伯贤通过开放检查后进入输入校验，避免调用外部服务。

## 现有角色兼容

伯贤未改任何角色包或声音文件，仍开放；四档提示词与原快照完全一致。

Kai、Mark原本 available:false 且没有manifest/完整角色包，仍作为合法占位保持离线；原有资料、文案均未修改，前端继续显示“即将开放”。没有被八文件校验误判为损坏角色包。

## 检查结果

- node --check：76个JS文件通过（lib、test、characters、public/shell以及server.js）。
- 分文件运行8个不含listen的测试文件，全部通过：account-cache、account-scope、fallback、hybe-batch2、layers、memory-cards、prompt-pack、s-core-batch1。
- 本批新增测试4项全部通过，覆盖17个语音哈希/fixture、27个关闭状态、每个必填文件漏列与缺失、聊天/TTS实际中间件拒绝，以及伯贤通过开放检查。
- 所有角色包inspect检查通过；Kai/Mark等既有不完整占位保持正常占位状态。
- git diff --check通过。
- 初次并行运行4个测试文件曾有一个文件级失败，单独及后续重跑通过；最终8个离线测试文件逐个独立运行全部通过。
- 没有执行npm test或需listen的HTTP集成测试，按用户说明留给外部环境。新增HTTP用例已完成语法检查。

## 未完成项

本批实现无已知未完成项。事实、出生日期与来源等待人工核验；语音配置按要求保持空；完整HTTP集成与全量测试等待外部执行。未联网、未下载图片、未执行git add/commit/push。
