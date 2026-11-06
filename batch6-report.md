# 第6批完成报告

本批新增10个目录，补全已有 gdragon 目录，保持原 id。全部11位在选择页可见，按钮为「暂未开放」，沿用现有服务端拦截机制。伯贤、Kai、Mark 的文件及状态文案未改动。

## 角色与年龄判定

截至2026年11月。成年判断依照有把握的模型常识，仍待人工核验；未核实不等于判定为未成年人。

| id | 姓名 | 出生日期 | 判定 | 最高档 |
| --- | --- | --- | --- | --- |
| chaeunwoo | 车银优 | 1997-03-30 | 成年 | flirty（非成人内容） |
| gdragon | 权志龙 | 1988-08-18 | 成年 | flirty（非成人内容） |
| taemin | 李泰民 | 1993-07-18 | 成年 | flirty（非成人内容） |
| juyeon | 李柱延 | 1998-01-15 | 成年 | flirty（非成人内容） |
| anxin | 周安信 | 未核实 | 年龄未核实，严格模式 | close（仅朋友式） |
| xinlong | 贺鑫隆 | 未核实 | 年龄未核实，严格模式 | close（仅朋友式） |
| sangwon | 李相沅 | 2003-05-08 | 成年 | flirty（非成人内容） |
| ricky | 沈泉锐 | 2004-05-20 | 成年 | flirty（非成人内容） |
| zhanghao | 章昊 | 2000-07-25 | 成年 | flirty（非成人内容） |
| gyuvin | 金奎彬 | 2004-08-30 | 成年 | flirty（非成人内容） |
| hanyujin | 韩维辰 | 2007-03-20 | 成年 | flirty（非成人内容） |

周安信、贺鑫隆：离线模型常识不足以确认年龄，birthDate=null、ageVerified=false、minor=null；严格模式无 flirty 人设，告白只感谢应援，close 仅朋友式支持。其余9位 ageVerified=true、minor=false。此 ageVerified 字段表示现有年龄策略所需的成年判断，不表示外部来源已核验。

## 文件改动

- 每个 characters/<id>/ 均含 manifest.json 及列出的8个必填文件、原创姓名首字 SVG 头像与肖像、voice/prepare.js、voice/voice.lock.json。
- 每人的性格、说话习惯、兴趣切入点及关系推进分别编写；兴趣作为原创互动素材，不冒充本人真实爱好或语录。moments 均标明虚构日常、无外部配图。fallbacks 为中性暂离话术。
- 所有语音包 version=<id>-placeholder-voice-1、pins=[]、tags=keep、voiceId=""，从 placeholderVoices.male 读取配置；未配置时不可发声。11份 test/fixtures/voice/<id>.json 使用 lib/voice-pack.contentHash 生成。
- gdragon 公司改为 Galaxy Corporation；taemin 按任务采用 Galaxy Corporation；juyeon 采用指定兜底「78 Records（团体）」。ALPHA DRIVE ONE、AND2BLE 及公司按任务分组填入，待人工核验。
- public/shell/picker.js 增加 Fantagio、Galaxy Corporation、78 Records、WAKEONE、YH 乐华显示标签；开放状态机制不变。
- batch6-age-report.json 保存逐人年龄判定；test/other-companies-batch6.test.js 新增完整性、可见性、年龄钳制、严格提示词、语音哈希与实际路由守卫的离线检查。

## 检查结果

通过以下8个离线测试文件：

`node --test test/other-companies-batch6.test.js test/hybe-batch2.test.js test/hybe-batch3.test.js test/sm-batch4.test.js test/jyp-yg-starship-batch5.test.js test/prompt-pack.test.js test/layers.test.js test/fallback.test.js`

本批测试在最终调整 fallback 后再次通过。实际路由守卫无需监听端口即可验证：本批11位及第1批10位均被 chat、TTS、history、scenes、moments 拦截，伯贤通过守卫。

`node --check`：picker.js、新增测试、11份 prepare.js 均通过。88个角色/fixture JSON文件解析通过。`git diff --check` 通过。

一次从 Node 内部 spawnSync 执行语法检查遇到沙箱 EPERM，改用 shell 直接运行 node --check 后11份全部通过。

## 待办与限制

- 姓名、出生日期、公司和团体资料均待人工核验；sources.json 明确记录模型常识及未核验状态。安信、鑫隆需核实成年后才可解除严格模式。
- 占位语音配置按要求留空；所有本批角色仍未开放。
- 未运行需要监听端口的全量 npm test，交由外部执行。
- 已完成本批代码与内容；无其他未完成实现项。全程未联网、未下载图片、未写入密钥、未执行 git add/commit/push。
