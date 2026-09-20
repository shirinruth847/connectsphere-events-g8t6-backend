/**
 * SUBTASK 11: NotificationService
 * Handles sending notifications to users
 * For MVP: logs to console
 * For production: integrate with email/SMS/in-app notification system
 */
 
export enum NotificationType {
  CLARIFICATION_REQUESTED = 'CLARIFICATION_REQUESTED',
  EVENT_RESUBMITTED = 'EVENT_RESUBMITTED',
  EVENT_APPROVED = 'EVENT_APPROVED',
  EVENT_REJECTED = 'EVENT_REJECTED'
}
 
export interface Notification {
  type: NotificationType;
  userId: string;
  eventId: string;
  title: string;
  message: string;
  actionUrl?: string;
  sentAt: Date;
}
 
export class NotificationService {
  /**
   * Send clarification requested notification
   * Sent to: Organiser
   */
  async notifyClarificationRequested(
    organiserId: string,
    eventId: string,
    coordinatorName: string,
    clarificationMessage: string
  ): Promise<void> {
    const notification: Notification = {
      type: NotificationType.CLARIFICATION_REQUESTED,
      userId: organiserId,
      eventId,
      title: 'Clarification Requested',
      message: `${coordinatorName} has requested clarification on your event: ${clarificationMessage}`,
      actionUrl: `/events/${eventId}/clarifications`,
      sentAt: new Date()
    };
 
    this.sendNotification(notification);
  }
 
  /**
   * Send event resubmitted notification
   * Sent to: Coordinator
   */
  async notifyEventResubmitted(
    coordinatorId: string,
    eventId: string,
    organiserName: string
  ): Promise<void> {
    const notification: Notification = {
      type: NotificationType.EVENT_RESUBMITTED,
      userId: coordinatorId,
      eventId,
      title: 'Event Resubmitted',
      message: `${organiserName} has resubmitted their event in response to your clarification request`,
      actionUrl: `/events/${eventId}/review`,
      sentAt: new Date()
    };
 
    this.sendNotification(notification);
  }
 
  /**
   * Send event approved notification
   * Sent to: Organiser
   */
  async notifyEventApproved(
    organiserId: string,
    eventId: string,
    coordinatorName: string
  ): Promise<void> {
    const notification: Notification = {
      type: NotificationType.EVENT_APPROVED,
      userId: organiserId,
      eventId,
      title: 'Event Approved',
      message: `Your event has been approved by ${coordinatorName}. Proceeding to planning.`,
      actionUrl: `/events/${eventId}/details`,
      sentAt: new Date()
    };
 
    this.sendNotification(notification);
  }
 
  /**
   * Send event rejected notification
   * Sent to: Organiser
   */
  async notifyEventRejected(
    organiserId: string,
    eventId: string,
    coordinatorName: string,
    rejectionReason: string
  ): Promise<void> {
    const notification: Notification = {
      type: NotificationType.EVENT_REJECTED,
      userId: organiserId,
      eventId,
      title: 'Event Rejected',
      message: `Your event has been rejected by ${coordinatorName}. Reason: ${rejectionReason}`,
      actionUrl: `/events/${eventId}/details`,
      sentAt: new Date()
    };
 
    this.sendNotification(notification);
  }
 
  /**
   * PRIVATE: Send notification
   * MVP implementation: logs to console
   * Production: would integrate with email/SMS/in-app systems
   */
  private sendNotification(notification: Notification): void {
    console.log(`
      ╔════════════════════════════════════════════════════════════╗
      ║ NOTIFICATION SENT                                          ║
      ║════════════════════════════════════════════════════════════║
      ║ Type: ${notification.type}                                 ║
      ║ To: ${notification.userId}                                 ║
      ║ Title: ${notification.title}                               ║
      ║ Message: ${notification.message}                           ║
      ║ Event: ${notification.eventId}                             ║
      ║ Timestamp: ${notification.sentAt.toISOString()}            ║
      ╚════════════════════════════════════════════════════════════╝
    `);
 
    // TODO: For production, integrate with:
    // - Email via Sendgrid/AWS SES
    // - SMS via Twilio
    // - In-app notification database
    // - Push notifications via Firebase
  }
}
 
export const notificationService = new NotificationService();
 