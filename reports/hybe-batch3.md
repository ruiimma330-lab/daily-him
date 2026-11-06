# 第3批角色包交付报告

新增 15 人，均设为 available:false / 暂未开放；本批无已有目录需要补全。
沿用既有选人页禁用按钮与服务端 requireAvailable 拦截，未改动伯贤、Kai、Mark 的配置和文案。

## 年龄判定

判断基准为 2026 年 11 月。下列出生日期来自模型常识，待人工核验；ageVerified:true 表示本批有把握已成年，不表示已进行证件或在线核验。全部 minor:false，允许 stranger / friend / close / flirty，所有档位禁止成人内容、编造现实恋爱与私生活。

| id | 出生日期 | 判定 | 严格模式 |
| --- | --- | --- | --- |
| wonwoo | 1996-07-17 | 成年 | 否 |
| mingyu | 1997-04-06 | 成年 | 否 |
| jeonghan | 1995-10-04 | 成年 | 否 |
| scoups | 1995-08-08 | 成年 | 否 |
| shinyu | 2003-11-07 | 成年 | 否 |
| dohoon | 2005-01-30 | 成年 | 否 |
| hanjin | 2006-01-05 | 成年 | 否 |
| tws-jihoon | 2006-03-28 | 成年 | 否 |
| myungjaehyun | 2003-12-04 | 成年 | 否 |
| taesan | 2004-08-10 | 成年 | 否 |
| wonhee | 2007-06-26 | 成年 | 否 |
| moka | 2004-10-08 | 成年 | 否 |
| minju | 2004-05-11 | 成年 | 否 |
| sakura | 1998-03-19 | 成年 | 否 |
| chaewon | 2000-08-01 | 成年 | 否 |

## 文件改动

- characters/<id>/：每人 8 个必填内容文件、manifest.json、原创姓名首字 avatar.svg / portrait.svg、voice/prepare.js 与 voice/voice.lock.json。每人独立的性格、语言节奏、兴趣切入点、关系阶段示例、日常场景；动态明确标注虚构日常。
- test/fixtures/voice/<id>.json：15 份占位语音夹具；使用 lib/voice-pack.contentHash 计算哈希，保留标签、空 pins、空 voiceId；按性别读取既有 placeholderVoices.male/female 配置位，未写入配置或密钥。
- public/shell/picker.js：补充 PLEDIS、KOZ、SOURCE MUSIC 公司筛选显示名。
- test/voice-pack.test.js：语音包数量断言从 28 更新为 43。
- test/hybe-batch3.test.js：检查包完整性、元数据、年龄、原创 SVG、语音锁与夹具；直接调用实际聊天/TTS 中间件验证拒绝，无需监听端口。
- batch3-age-report.json：机器可读逐人年龄判定。

## 已运行检查

- 串行运行以下 9 个测试文件，全部通过：hybe-batch3、hybe-batch2、s-core-batch1、prompt-pack、account-cache、account-scope、fallback、layers、memory-cards。
- 新测试最后修改后单独重跑通过；使用逐角色 publicInfo 避开其他测试临时增删角色目录时的枚举干扰。
- 15 个 prepare.js 与 picker.js、新测试、voice-pack.test.js、server.js 共 19 个 JS 文件 node --check 通过。
- 本批根目录 JSON 逐一解析通过；语音夹具与锁文件由包检查验证；语音包总数为 43。
- git diff --check 通过。
- 早期并行组合运行中本批测试失败、单独重跑通过，随后改为串行完成验证。Node 子进程启动语法检查曾被沙箱 EPERM 拒绝，改为 shell 直接执行 node --check 后全部通过。

## 待外部处理

- 基础信息、公司归属与出生日期待人工核验；sources.json 已明确来源为模型常识。
- 全量接口测试交由外部执行；未运行 npm test 或监听端口。
- 无剩余实现项。全程未联网、未下载图片、未写入密钥、未执行 git add/commit/push。
