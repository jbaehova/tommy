import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.claudeWriteOutside": "에이전트의 워크스페이스, 공유 폴더, 임시 폴더 밖에 있는 {path}에 써요.",
  "status.agent.contextCleared": "컨텍스트를 지웠어요. 여기서 새 채팅이 시작돼요.",
  "status.agent.instructionsChanged": "지침을 업데이트했어요",
  "status.agent.modelSwitchedForLimit": "사용 한도에 도달했어요. {model}(으)로 전환했어요.",
  "status.agent.modelReturnedAfterLimit": "사용 한도가 끝났어요. {model}(으)로 다시 전환했어요.",
  "status.agent.modelSwitchedForError": "제공자 오류가 발생했어요. {model}(으)로 전환했어요.",
  "status.agent.modelReturnedAfterError": "제공자 오류 후 {model}(으)로 다시 전환했어요.",
  "status.agent.channelMemberAdded": "{agent} 에이전트가 {member} 멤버를 채널에 추가했어요. {person} 님이 요청했어요.",
  "status.agent.channelMemberRemoved":
    "{agent} 에이전트가 {member} 멤버를 채널에서 제거했어요. {person} 님이 요청했어요.",
  "status.agent.channelInstructionsChanged": "{agent} 에이전트가 채널 지침을 변경했어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineCreated": "{agent} 에이전트가 루틴 {routine}을(를) 만들었어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineUpdated": "{agent} 에이전트가 루틴 {routine}을(를) 변경했어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineDeleted": "{agent} 에이전트가 루틴 {routine}을(를) 삭제했어요. {person} 님이 요청했어요.",
  "status.agent.vaultSiteApproval":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\n이 사이트에서는 다음부터 승인 없이 입력해요.",
  "status.agent.vaultSiteApprovalFrames":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\n결제 프레임: {origins}\n이 사이트에서는 다음부터 승인 없이 입력해요.",
  "status.agent.vaultCardFillVault":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\n이 사이트에서는 다음부터 승인 없이 입력해요. 서버 설정 > Vault에서 사이트를 지울 수 있어요.",
  "status.agent.vaultCardFillVaultFrames":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\n결제 프레임: {origins}\n이 사이트에서는 다음부터 승인 없이 입력해요. 서버 설정 > Vault에서 사이트를 지울 수 있어요.",
  "status.agent.vaultCardFillOnePassword":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\nTommy를 다시 시작할 때까지 이 사이트에서는 승인 없이 입력해요.",
  "status.agent.vaultCardFillOnePasswordFrames":
    "금액: {amount} (에이전트가 읽은 값)\n카드: {card}\n사이트: {site}\n결제 프레임: {origins}\nTommy를 다시 시작할 때까지 이 사이트에서는 승인 없이 입력해요.",
  "status.agent.screenCaptureProgress": "화면 캡처를 요청하는 중…",
  "status.agent.screenCaptureReviewing": "화면 캡처를 확인하는 중…",
  "status.agent.browserOpening": "웹 페이지를 여는 중…",
  "status.agent.browserReading": "웹 페이지를 읽는 중…",
  "status.agent.browserClicking": "웹 페이지를 클릭하는 중…",
  "status.agent.browserTyping": "웹 페이지에 입력하는 중…",
  "status.agent.browserActing": "웹 페이지를 사용하는 중…",
  "status.agent.browserReviewing": "웹 페이지를 확인하는 중…",
  "status.agent.memoriesSearching": "메모리를 검색하는 중…",
  "status.agent.memoriesSearched": {
    other: "메모리를 검색했어요: {count}개 찾음",
  },
  "status.agent.memoriesUpdating": "메모리를 업데이트하는 중…",
  "status.agent.skillUsing": "스킬 {name}을(를) 사용하는 중…",
  "status.agent.skillReading": "스킬을 읽는 중…",
  "status.agent.toolStepFailed": "도구 단계가 실패했습니다. 결과를 확인하고 다음에 시도할 작업을 결정하는 중…",
  "status.agent.toolResultReviewing": "최신 도구 결과를 확인하는 중…",
  "status.agent.sourcesSearching": "최신 정보를 검색하는 중…",
  "status.agent.sourcesReviewing": "찾은 출처와 정보를 확인하는 중…",
  "status.agent.informationGathering": "관련 정보를 수집하는 중…",
  "status.agent.informationReviewing": "수집한 정보를 확인하는 중…",
  "status.agent.workChecking": "작업을 확인하는 중…",
  "status.agent.workReviewing": "검증 결과를 확인하는 중…",
  "status.agent.changesMaking": "요청된 변경 사항을 적용하는 중…",
  "status.agent.changesReviewing": "적용한 변경 사항을 확인하는 중…",
  "status.agent.agentCoordinating": "다른 에이전트와 조정하는 중…",
  "status.agent.agentResponseReviewing": "다른 에이전트의 응답을 확인하는 중…",
  "status.agent.toolStepWorking": "다음 도구 단계를 처리하는 중…",
  "status.agent.memoryChanges": "메모리: {saved}개 저장, {updated}개 업데이트, {forgotten}개 삭제.",
  "status.agent.memoryChangesWithConflicts":
    "메모리: {saved}개 저장, {updated}개 업데이트, {forgotten}개 삭제, {notChanged}개는 다른 스레드가 먼저 변경해서 변경 안 됨.",
  "status.agent.mcpServerAdd":
    "MCP 서버 {name}을(를) 추가해요: {target}. 이 서버의 모든 에이전트가 해당 도구를 사용할 수 있어요. Tommy가 연결을 테스트해요.",
  "status.agent.mcpServerChange":
    "MCP 서버 {name}을(를) {target}(으)로 변경해요. 이 서버의 모든 에이전트가 해당 도구를 사용할 수 있어요. Tommy가 연결을 테스트해요.",
  "status.agent.mcpServerEnable": "이 서버의 모든 에이전트에 MCP 서버 {name}을(를) 켜요.",
  "status.agent.mcpServerDisable": "이 서버의 모든 에이전트에 MCP 서버 {name}을(를) 꺼요.",
  "status.agent.mcpServerRemove": "이 서버의 모든 에이전트에서 MCP 서버 {name}과(와) 로그인 정보를 제거해요.",
  "status.agent.mcpSignInConnect": "{name}에 로그인이 필요해요. Telegram에서 연결 버튼을 누르세요.",
  "status.agent.mcpSignInRequested": "MCP 서버 {name}에 로그인이 필요해요. 서버 설정의 MCP에서 로그인해 주세요.",
  "status.agent.nextStepContinues": "에이전트가 다음 단계 전에 멈췄어요. 계속해요 ({current}/{limit}).",
  "status.agent.planContinues": "계획에 남은 단계가 있어요. 에이전트가 계속해요 ({current}/{limit}).",
  "status.agent.branchTitle": "분기된 채팅",
  "status.agent.compactionContinues": "에이전트가 컨텍스트를 압축하는 동안 연결이 끊겼어요. 에이전트가 계속해요.",
  "status.agent.workflowDelete": "워크플로 {title}과 실행 기록, 버전을 삭제해요. 진행 중인 단계도 중지돼요.",
  "status.agent.telegramEngineUsage":
    "이 에이전트에 사용할 엔진을 선택하려면 /engine codex 또는 /engine claude를 보내세요.",
  "status.agent.telegramEngineSet": "이 에이전트는 {engine}의 {model} 모델을 사용합니다.",
  "status.agent.telegramEngineQueued": "현재 작업을 마치면 이 에이전트가 {engine}의 {model} 모델을 사용합니다.",
  "status.agent.telegramEngineUnavailable":
    "{engine}을 선택할 수 없습니다. VPS에서 해당 공급자의 연결 상태와 사용 가능한 모델을 확인하세요.",
  "status.agent.telegramNameUsage": "/name 다음에 공개할 표시 이름을 입력하세요. 한 줄에 64자까지 사용할 수 있습니다.",
  "status.agent.telegramNameRefused": "Tommy에서 에이전트 표시 이름을 변경하지 못했습니다.",
  "status.agent.telegramNameRetry":
    "Tommy에 표시 이름을 저장했습니다. 같은 /name 명령을 다시 보내 텔레그램 프로필에도 적용하세요.",
  "status.agent.telegramNameSet": "Tommy와 텔레그램 기본 프로필의 표시 이름을 {name}(으)로 설정했습니다.",
} as const satisfies PartialTranslation<typeof source>;
