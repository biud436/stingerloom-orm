import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Notification } from "./notification.entity";
import { IssueWatcher } from "./issue-watcher.entity";
import { NotificationsService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";
import {
  CommentMentionSubscriber,
  IssueChangeSubscriber,
} from "./notification-events.subscriber";

@Module({
  imports: [StingerloomOrmModule.forFeature([Notification, IssueWatcher])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    CommentMentionSubscriber,
    IssueChangeSubscriber,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
