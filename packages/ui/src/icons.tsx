import { forwardRef } from 'react';
import { ArrowRightUpIcon as SolarArrowRight } from '@solar-icons/react/linear/arrow-right-up';
import { AddIcon as SolarAdd } from '@solar-icons/react/linear/add';
import { AltArrowDownIcon as SolarChevronDown } from '@solar-icons/react/linear/alt-arrow-down';
import { AltArrowRightIcon as SolarChevronRight } from '@solar-icons/react/linear/alt-arrow-right';
import { ArrowUpIcon as SolarArrowUp } from '@solar-icons/react/linear/arrow-up';
import { ChatSquareIcon as SolarChat } from '@solar-icons/react/linear/chat-square';
import { CheckIcon as SolarCheck } from '@solar-icons/react/linear/check';
import { CloseIcon as SolarClose } from '@solar-icons/react/linear/close';
import { CopyIcon as SolarCopy } from '@solar-icons/react/linear/copy';
import { CursorIcon as SolarCursor } from '@solar-icons/react/linear/cursor';
import { DownloadMinimalisticIcon as SolarDownload } from '@solar-icons/react/linear/download-minimalistic';
import { GalleryIcon as SolarGallery } from '@solar-icons/react/linear/gallery';
import { GallerySendIcon as SolarGallerySend } from '@solar-icons/react/linear/gallery-send';
import { Grid2x2Icon as SolarGrid } from '@solar-icons/react/linear/grid-2x2';
import { HistoryIcon as SolarHistory } from '@solar-icons/react/linear/history';
import { ListOrderedIcon as SolarListOrdered } from '@solar-icons/react/linear/list-ordered';
import { MenuDotsIcon as SolarMenuDots } from '@solar-icons/react/linear/menu-dots';
import { SettingsIcon as SolarSettings } from '@solar-icons/react/linear/settings';
import { StopIcon as SolarStop } from '@solar-icons/react/linear/stop';
import { StopCircleIcon as SolarStopCircle } from '@solar-icons/react/linear/stop-circle';
import { TextFormatIcon as SolarTextFormat } from '@solar-icons/react/linear/text-format';
import { TrashBinMinimalisticIcon as SolarTrash } from '@solar-icons/react/linear/trash-bin-minimalistic';
import { UndoLeftRoundIcon as SolarUndo } from '@solar-icons/react/linear/undo-left-round';
import { UndoRightRoundIcon as SolarRedo } from '@solar-icons/react/linear/undo-right-round';
import { UploadMinimalisticIcon as SolarUpload } from '@solar-icons/react/linear/upload-minimalistic';
import { WaterdropIcon as SolarWaterdrop } from '@solar-icons/react/linear/waterdrop';
import { CropMinimalisticIcon as SolarCrop } from '@solar-icons/react/linear/crop-minimalistic';
import type { Icon } from '@solar-icons/react/lib/types';

export type IconComponent = Icon;

// Solar draws Linear icons at 1.5 on a 24 grid; 2.25 matches the line weight of the 16-unit
// icons they replace at 16px and 20px.
function linear(Solar: Icon, displayName: string): Icon {
  const Component = forwardRef<SVGSVGElement, React.ComponentPropsWithoutRef<Icon>>((props, ref) => (
    <Solar ref={ref} strokeWidth={2.25} {...props} />
  ));
  Component.displayName = displayName;
  return Component;
}

export const UndoIcon = linear(SolarUndo, 'UndoIcon');
export const RedoIcon = linear(SolarRedo, 'RedoIcon');
export const DragOutIcon = linear(SolarGallerySend, 'DragOutIcon');
export const CopyIcon = linear(SolarCopy, 'CopyIcon');
export const SaveIcon = linear(SolarDownload, 'SaveIcon');
export const EditorIcon = linear(SolarCrop, 'EditorIcon');
export const HistoryIcon = linear(SolarHistory, 'HistoryIcon');
export const SettingsIcon = linear(SolarSettings, 'SettingsIcon');
export const AddIcon = linear(SolarAdd, 'AddIcon');
export const UploadIcon = linear(SolarUpload, 'UploadIcon');
export const MoreIcon = linear(SolarMenuDots, 'MoreIcon');
export const CloseIcon = linear(SolarClose, 'CloseIcon');
export const ImageIcon = linear(SolarGallery, 'ImageIcon');
export const ChevronDownIcon = linear(SolarChevronDown, 'ChevronDownIcon');
export const ChevronRightIcon = linear(SolarChevronRight, 'ChevronRightIcon');
export const CheckIcon = linear(SolarCheck, 'CheckIcon');
export const SelectToolIcon = linear(SolarCursor, 'SelectToolIcon');
export const ArrowToolIcon = linear(SolarArrowRight, 'ArrowToolIcon');
export const RectToolIcon = linear(SolarStop, 'RectToolIcon');
export const TextToolIcon = linear(SolarTextFormat, 'TextToolIcon');
export const StepToolIcon = linear(SolarListOrdered, 'StepToolIcon');
export const BlurToolIcon = linear(SolarWaterdrop, 'BlurToolIcon');
export const PixelateToolIcon = linear(SolarGrid, 'PixelateToolIcon');
export const DeleteIcon = linear(SolarTrash, 'DeleteIcon');
export const ChatIcon = linear(SolarChat, 'ChatIcon');
export const SendIcon = linear(SolarArrowUp, 'SendIcon');
export const StopIcon = linear(SolarStopCircle, 'StopIcon');

