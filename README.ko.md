# FM PCC Router

[English](README.md)

Apple Foundation Models와 Private Cloud Compute(PCC)를 이용해 OpenCode 요청을 라우팅하고, Codex 작업을 맡을 서브에이전트의 모델과 추론 강도를 선택합니다.

## 라우팅 방식

라우터는 모델을 선택할 때만 임시 Terminal 창에서 `fm respond --model pcc`를 한 번 실행합니다. 입력은 비공개 transcript 파일로 전달하고, 호출이 끝나면 창을 닫습니다. 작업의 모델 추론은 선택된 provider가 실행합니다.

### OpenCode

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-opencode-dark.png">
  <img alt="로컬 macOS, Apple PCC, 선택된 provider 사이의 OpenCode 라우팅 경로" src="docs/architecture-opencode.png">
</picture>

OpenCode는 현재 채팅의 최근 기록을 사용하고, 라우팅 상태를 채팅별로 관리합니다. 검증된 모델은 현재 세션에 적용됩니다. 채팅을 삭제하면 해당 로컬 라우팅 기록도 삭제됩니다.

### Codex

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-codex-dark.png">
  <img alt="로컬 제출 훅과 라우터, Apple PCC, 선택된 모델 서비스를 연결하는 Codex 위임 경로" src="docs/architecture-codex.png">
</picture>

Codex 도구는 상위 에이전트가 서브에이전트 라우팅을 요청할 때 실행됩니다. 스레드 ID가 있으면 같은 Codex 채팅의 최근 위임 설명을 재사용합니다.

## 요구사항

- Apple Intelligence와 PCC를 사용할 수 있는 macOS 27 이상
- Node.js 20 이상 및 Git
- OpenCode 라우팅에는 OpenCode 2 데스크톱 앱과 연결된 provider
- Codex에는 모델·추론 강도를 지정해 서브에이전트를 시작할 수 있는 세션이 필요합니다. 라우터는 ChatGPT 데스크톱 앱에 포함된 App Server도 사용할 수 있습니다.

## 설치

```sh
git clone https://github.com/mindarlynn/fm-pcc-router.git
cd fm-pcc-router
node install.mjs
```

방향키로 이동하고 **Space**로 앱 하나 또는 둘 다 선택한 뒤 **Enter**로 설치합니다. **Esc**로 취소할 수 있습니다. 메뉴를 건너뛰려면 `--target opencode`, `--target codex`, `--target both` 중 하나를 지정합니다. 기존 설치를 업데이트하려면 먼저 `node install.mjs --uninstall`로 해당 앱의 라우터를 제거한 뒤 설치합니다.

어느 앱을 선택해도 `fm-pcc-router` 명령이 `~/.local/bin` 또는 `$XDG_BIN_HOME`에 설치됩니다. 설치 경로가 `PATH`에 없으면 설치기가 zsh 또는 Bash 시작 파일에서 `PATH` 끝에 추가합니다. 새 터미널 탭을 열면 명령을 사용할 수 있습니다. 다른 셸에서는 설치기가 전체 실행 경로를 표시합니다.

### 설치 후

- **OpenCode** — 앱을 다시 시작하고 평소 프로젝트에서 채팅합니다. 플러그인이 모델을 선택해 자동으로 적용합니다.
- **Codex** — 설치기가 `fm-pcc-router` 스킬과 Codex 사용자 훅을 함께 등록합니다. 새 훅을 불러오려면 **Cmd+Q**로 Codex 앱을 완전히 종료한 뒤 다시 엽니다. 그런 다음 **Settings > Hooks**에서 `UserPromptSubmit`을 검토하고 신뢰합니다. 새 채팅에서 Codex에 작업 위임을 요청합니다. Codex가 훅의 지침을 따르면 위임할 작업 설명을 PCC에 보내고, 선택된 모델과 추론 강도로 서브에이전트를 시작합니다. 명시된 설정이 우선합니다.

`$fm-pcc-router`로 작업 하나를 직접 라우팅할 수도 있습니다. 선택 사항인 `PostModelRequest` 훅을 신뢰하면 선택 모델과 서브에이전트 요청에서 관측된 모델을 대조합니다.

첫 PCC 요청에서 macOS가 Terminal 제어 권한을 요청할 수 있습니다. App Server와 Terminal.app을 시작할 때 로컬 실행 승인이 필요할 수 있습니다.

## provider 제한 설정

특정 provider만 선택하도록 제한하려면 전역 설정 `~/.config/opencode/opencode.json` 또는 `opencode.jsonc`의 `plugins` 배열에 아래 항목을 추가합니다. `allowedProviders`에는 OpenCode의 provider ID를 지정합니다.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/fm-pcc-router/",
      "options": {
        "allowedProviders": ["openai"]
      }
    }
  ]
}
```

목록에 있는 provider 중 연결된 provider만 사용합니다. 빈 목록은 모든 모델 선택을 차단합니다. 예시를 적용할 때 다른 설정과 기존 플러그인 항목은 유지합니다.

## 모델 후보 제한 설정

기본값은 허용된 모든 provider의 적격 모델을 고려합니다. Provider당 후보 수를 제한하려면 `~/.config/fm-pcc-router/routing.json`을 만듭니다. `$XDG_CONFIG_HOME`을 쓰는 경우에는 그 아래에 `fm-pcc-router/routing.json`을 둡니다.

```json
{
  "hosts": {
    "opencode": { "maxModelsPerProvider": 12 },
    "codex": { "maxModelsPerProvider": 12 }
  }
}
```

특정 모델만 허용하려면 각 앱 설정에 `{"providerID":"openai","id":"your-model-id"}` 형태의 항목을 담은 `models` 배열을 추가합니다. Codex 모델의 provider ID는 `codex`입니다. `models`를 생략하면 적격 모델 전체가 후보 범위에 들어갑니다. OpenCode의 provider 제한은 계속 적용됩니다. 설정 파일이 잘못되면 수정할 때까지 라우팅이 중단됩니다. PCC 입력 한도를 넘으면 선택적 모델 설명을 먼저 빼고, 그래도 크면 설정 범위 안에서 요청에 명시한 적격 모델을 보존하면서 provider별 후보를 고르게 추립니다.

## 라우팅 전략

새 채팅은 내장 전략인 `default`로 시작합니다. 두 앱에서 재사용할 전략을 추가하려면 `~/.config/fm-pcc-router/strategies.json`을 만듭니다. `$XDG_CONFIG_HOME`을 쓰는 경우에는 그 아래에 `fm-pcc-router/strategies.json`을 둡니다.

```json
{
  "fast": "반복 작업에서는 빠른 응답과 낮은 추론 강도를 우선합니다.",
  "review": "보안 리뷰나 복잡한 디버깅에서는 정확도와 깊은 추론을 우선합니다."
}
```

터미널에서 아래 명령을 실행합니다. `<chat-ref>`에는 대상 채팅의 참조를 넣습니다.

```sh
fm-pcc-router strategy list
fm-pcc-router strategy current --chat '<chat-ref>'
fm-pcc-router strategy use review --chat '<chat-ref>'
fm-pcc-router strategy use default --chat '<chat-ref>'
```

- **OpenCode** — `opencode:<세션 ID>`를 사용합니다. 채팅이 속한 프로젝트에서 `opencode session list`를 실행하면 ID를 확인할 수 있습니다.
- **Codex** — 채팅에서 **Cmd+Option+L**로 복사한 `codex://threads/<id>` 링크를 사용합니다. 선택한 전략은 서브에이전트 라우팅에 적용됩니다.

두 앱 모두 채팅별로 전략 선택과 transcript를 보관합니다. 관리 명령은 채팅 밖에서 실행됩니다. 전략 파일을 수정하면 다음 라우팅부터 반영됩니다. 사용 중인 전략을 삭제했다면 다른 전략을 선택하거나 `default`로 되돌립니다.

전략 이름은 소문자로 시작하며 소문자, 숫자, 하이픈을 합쳐 최대 40자입니다. 전략 지침은 항목당 UTF-8 2,000바이트, 파일 전체는 32KB까지 쓸 수 있습니다. PCC는 선택된 전략의 지침을 받아 적격 후보의 우선순위를 정합니다. 연결된 provider 제한, 모델 자격 조건, 사용자가 명시한 선택은 계속 우선합니다.

## 연결 확인

터미널에서 `fm-pcc-router test`를 실행하면 고정된 진단 요청으로 PCC 연결을 확인할 수 있습니다. 실패하면 Apple Intelligence 사용 가능 여부, PCC 사용 한도, Terminal 제어 권한을 확인합니다.

`fm-pcc-router doctor`는 설치된 연동, Codex 훅 등록, 로컬 설정과 저장소 권한을 읽기 전용으로 점검합니다. 대화나 전략 내용을 표시하지 않으며 PCC에 접속하지 않습니다. 훅 신뢰 여부는 Codex 설정에서 확인합니다.

## 데이터 처리

OpenCode는 라우팅을 위해 현재 요청과 제한된 최근 대화 텍스트를 보냅니다. Codex는 현재 위임 설명과 같은 채팅의 제한된 최근 위임 설명을 보냅니다. 두 앱 모두 후보 모델 정보와 선택한 커스텀 전략의 지침이 있는 경우 해당 지침을 Apple PCC에 전달합니다. 라우터는 첨부 파일, 저장소 파일, Codex 대화 기록을 읽지 않습니다. 위임 메시지에 민감한 내용을 넣지 말고, Apple PCC로 작업 텍스트를 전송할 수 있는 환경에서 자동 훅을 사용합니다.

라우팅 기록은 로컬의 `$XDG_STATE_HOME/fm-pcc-router/sessions`에 저장됩니다(기본값은 `~/.local/state/fm-pcc-router/sessions`). 채팅마다 최대 8개 항목과 UTF-8 6,000바이트를 보관하며, 7일이 지난 기록은 재사용하지 않습니다. 전체 라우팅 기록을 지우려면 라우터를 사용하지 않는 동안 이 디렉터리를 삭제합니다.

## 제거

```sh
node install.mjs --uninstall
```

제거 메뉴에는 설치된 연동만 표시됩니다. **Space**로 선택하고 **Enter**로 제거합니다. 설치된 연동이 없으면 안내하고 종료합니다. Codex를 제거하면 설치된 스킬과 훅도 함께 제거됩니다. 마지막 앱의 연동을 제거할 때 공용 명령과 설치기가 추가한 PATH 항목도 삭제됩니다. 해당 앱을 다시 시작합니다.

개발과 테스트는 [기여 안내](.github/CONTRIBUTING.md), 릴리스 내역은 [변경 기록](docs/CHANGELOG.md)을 참고하세요.

## 라이선스

[MIT](LICENSE)
