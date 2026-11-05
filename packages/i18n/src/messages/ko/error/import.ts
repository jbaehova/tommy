import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/import";

export const messages = {
  "error.import.memoryLimit": "{name}: 처음 {limit}개의 메모리만 가져왔어요.",
  "error.import.skillFolderMissing": "{name}: 스킬 폴더 {skill}에 SKILL.md가 없어요.",
  "error.import.avatarSkipped": "{name}: 아바타가 512 KB 이하의 PNG, JPEG 또는 WebP가 아니어서 건너뛰었어요.",
  "error.import.exportClosed": "내보내기 파일이 더 이상 열려 있지 않아요. 다시 선택해 주세요.",
  "error.import.agentNotInExport": "선택한 항목에 내보내기 파일에 없는 에이전트가 있어요.",
  "error.import.serverAgentLimit": "서버당 에이전트는 최대 {limit}개까지 가능해요.",
  "error.import.exportChanged": "확인한 후 내보내기 파일이 변경되었어요. 다시 선택해 주세요.",
  "error.import.routineSkipped": '{name}: 루틴 "{routine}"을(를) 건너뛰었어요. {reason}',
  "error.import.fileRenamed": "{name}: {file}이(가) 이미 있어서 이 사본을 {saved}(으)로 저장했어요.",
  "error.import.fileSkipped": "{name}: 파일 {file}을(를) 건너뛰었어요. {reason}",
  "error.import.chooseZip": ".zip 파일을 선택해 주세요.",
  "error.import.unsafeFile": "내보내기 파일에 안전하지 않은 파일이 있어요: {name}",
  "error.import.empty": "내보내기 파일이 비어 있어요.",
  "error.import.transferRemoteTooLarge":
    "참여 중인 서버용 이전 파일은 100 MB 이하여야 해요. 워크스페이스 파일을 끄거나 에이전트를 더 적게 내보내 주세요.",
  "error.import.transferNotFile": "이 파일은 Tommy 이전 파일이 아니에요.",
  "error.import.transferNewer": "더 최신 버전의 Tommy로 만든 파일이에요. Tommy를 업데이트한 후 다시 시도해 주세요.",
  "error.import.transferEmpty": "파일에 에이전트도 설정도 없어요.",
  "error.import.transferTooLarge":
    "이전 파일은 2 GB 이하, 파일 50,000개 이하여야 해요. 워크스페이스 파일을 끄거나 에이전트를 더 적게 내보내 주세요.",
  "error.import.transferAgentInvalid": "파일의 에이전트 {number}이(가) 올바르지 않아서 건너뛰었어요.",
  "error.import.transferSettingsInvalid": "파일의 앱 설정이 올바르지 않아서 가져오지 않았어요.",
  "error.import.transferModelMissing":
    '{name}: 모델 "{model}"을(를) 아직 여기서 사용할 수 없어서 에이전트가 기본 모델을 사용해요. 제공자가 준비되면 모델을 다시 선택해 주세요.',
  "error.import.transferSettingSkipped": "{name}을(를) 가져오지 않았어요. {reason}",
  "error.import.transferRoutineFlowSkipped": "가져오기에서 루틴 플로우 하나를 제외했어요. {reason}",
  "error.import.transferCustomAgentCommand":
    '{name}: 커스텀 에이전트는 명령을 실행하므로 가져오지 않았어요. 명령 "{command}"을(를) 확인한 후 설정에서 에이전트를 다시 추가해 주세요.',
  "error.import.transferSkillLimit":
    "{name}: 에이전트는 스킬을 {limit}개까지 가질 수 있어서, 스킬 {total}개 중 처음 {limit}개만 파일에 있어요.",
  "error.import.transferFilesGone": "내보내는 동안 파일 {number}개가 삭제되어 파일에 포함되지 않았어요.",
  "error.import.transferProviderKey": "{name}: 설정에서 API 키를 다시 입력해 주세요.",
  "error.import.transferMcpValues":
    "{name}: MCP 서버를 꺼진 상태로 추가했어요. 명령을 확인하고 값과 전체 주소를 다시 입력한 후 MCP 설정에서 켜 주세요.",
  "error.import.transferSharedKept": "공유 폴더의 파일 {number}개는 이미 여기에 있어서 그대로 두었어요.",
} as const satisfies PartialTranslation<typeof source>;
