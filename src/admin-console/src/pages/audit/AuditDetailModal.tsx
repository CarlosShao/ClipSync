import { Modal, Descriptions, Tag } from 'antd';
import { StatusTag } from '@/components/StatusTag';
import { operatorRoleLabel, operatorRoleTone } from '@/components/StatusTag/mappers';
import { parseDetailsToJson } from './auditDetail';
import { isSensitiveAction } from './sensitive';
import type { AuditLog } from '@/api/types';
import styles from './audit.module.css';

interface AuditDetailModalProps {
  open: boolean;
  log: AuditLog | null;
  onClose: () => void;
}

/** 审计详情弹窗：完整字段 + details 摘要 JSON 格式化展示 */
export function AuditDetailModal({ open, log, onClose }: AuditDetailModalProps) {
  const sensitive = log ? isSensitiveAction(log.action) : false;
  const detailsJson = log ? JSON.stringify(parseDetailsToJson(log.details), null, 2) : '';

  return (
    <Modal
      open={open && Boolean(log)}
      title={
        <span>
          审计详情
          {sensitive ? (
            <Tag color="red" style={{ marginLeft: 8 }}>
              敏感操作
            </Tag>
          ) : null}
        </span>
      }
      footer={null}
      onCancel={onClose}
      width={560}
    >
      {log ? (
        <>
          <Descriptions
            size="small"
            column={2}
            bordered
            labelStyle={{ whiteSpace: 'nowrap', width: 92 }}
            items={[
              { key: 'time', label: '时间', span: 2, children: <span className={styles.monoCell}>{log.createdAt}</span> },
              {
                key: 'operator',
                label: '操作者',
                children: (
                  <>
                    <b>{log.operator}</b>
                    {log.operatorRole === 'super_admin' || log.operatorRole === 'admin' ? (
                      <StatusTag tone={operatorRoleTone[log.operatorRole]} dot={false}>
                        {operatorRoleLabel[log.operatorRole]}
                      </StatusTag>
                    ) : null}
                  </>
                ),
              },
              { key: 'result', label: '结果', children: log.status === 'success' ? <StatusTag tone="green">成功</StatusTag> : <StatusTag tone="red">失败</StatusTag> },
              { key: 'action', label: '动作', span: 2, children: <span className={`${styles.actionCell} ${sensitive ? styles.actionSensitive : ''}`}>{log.action}</span> },
              { key: 'resourceType', label: '资源类型', children: <span className={styles.monoCell}>{log.resourceType || '—'}</span> },
              { key: 'resourceId', label: '资源 ID', children: <span className={styles.monoCell}>{log.resourceId || '—'}</span> },
              { key: 'ip', label: 'IP', children: <span className={styles.monoCell}>{log.ipAddress || '—'}</span> },
              { key: 'ua', label: 'User-Agent', children: <span className={styles.monoCell}>{log.userAgent || '—'}</span> },
            ]}
          />
          <div className={styles.detailJsonLabel}>details（JSON）</div>
          <pre className={styles.detailJson}>{detailsJson}</pre>
        </>
      ) : null}
    </Modal>
  );
}
